import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import ExcelJS from 'exceljs';
import { decryptIlink, detectMediaExt } from './ilink_crypto.js';
import { transcodeVoice } from './voice_transcode.js';
import { isPureEmojiText } from './wechatEmoji.js';
import { assertPublicUrl } from './ssrf.js';
import { downloadToBuffer } from './netguard.js';

// LIKE 通配符转义：用户输入的 % 与 _ 必须转义，否则搜索「100%」会退化成全表匹配。
// 转义符统一用反斜杠，并在 SQL 侧声明 ESCAPE '\'。
function escapeLike(s) {
  return String(s).replace(/[\\%_]/g, (c) => '\\' + c);
}

// 判断 buffer 是否已是可识别的图片/音频文件头（用于决定是否需要 AES 解密）
function isMediaHeader(buf) {
  if (!buf || buf.length < 12) return false;
  const b = buf;
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return true; // PNG
  if (b[0] === 0xff && b[1] === 0xd8) return true; // JPEG
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return true; // GIF
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46) return true; // RIFF / WEBP
  if (b[0] === 0x49 && b[1] === 0x44 && b[2] === 0x33) return true; // ID3 (MP3)
  if ((b[0] & 0xff) === 0xff && (b[1] & 0xe0) === 0xe0) return true; // MP3 帧
  if (b[0] === 0x23 && b[1] === 0x21 && b[2] === 0x41 && b[3] === 0x4d && b[4] === 0x52) return true; // #!AMR
  if (b[0] === 0x4f && b[1] === 0x67 && b[2] === 0x67 && b[3] === 0x53) return true; // Ogg
  if (b[0] === 0x66 && b[1] === 0x4c && b[2] === 0x61 && b[3] === 0x43) return true; // fLaC
  return false;
}

// 归档存储：SQLite 元数据索引 + 飞牛文件系统分类落盘
// 纯文本 / 语音 → 写入 [通道]/聊天.xlsx（不在分类文件夹落 Markdown）
// 图片 / 文件 / 视频 / 链接等 → 按平台类型归入分类文件夹（Markdown + SQLite）
export class Storage {
  constructor({ dataDir, archiveRoot }) {
    this.archiveRoot = archiveRoot;
    fs.mkdirSync(dataDir, { recursive: true });
    fs.mkdirSync(archiveRoot, { recursive: true });
    this.db = new Database(path.join(dataDir, 'archive.db'));
    this._stmts = new Map(); // 预编译语句缓存（见 _stmt）
    this.db.pragma('journal_mode = WAL');
    // 低危：WAL 无 checkpoint —— 显式设定自动 checkpoint 阈值，并周期 TRUNCATE 收敛 WAL 文件，
    // 避免归档.db-wal / -shm 长期不收敛导致体积膨胀与恢复变慢。
    this.db.pragma('wal_autocheckpoint = 1000');
    const _walTimer = setInterval(() => {
      try {
        this.db.pragma('wal_checkpoint(TRUNCATE)');
      } catch {
        /* 忽略瞬时失败 */
      }
    }, 15 * 60 * 1000);
    if (_walTimer && typeof _walTimer.unref === 'function') _walTimer.unref();
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        channel_id TEXT,
        channel_name TEXT,
        peer TEXT,
        ts INTEGER,
        category TEXT,
        sub TEXT,
        text TEXT,
        kind TEXT,
        path TEXT,
        voice TEXT,
        media TEXT,
        filename TEXT,
        created_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_msgs_channel ON messages(channel_id);
      CREATE INDEX IF NOT EXISTS idx_msgs_cat ON messages(category, sub);
      CREATE INDEX IF NOT EXISTS idx_msgs_ts ON messages(ts);
    `);
    // 媒体去重表：同一通道内内容相同的文件只存一份，避免重复占用空间
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS media_hashes (
        hash TEXT PRIMARY KEY,
        rel TEXT NOT NULL,
        channel_name TEXT NOT NULL
      );
    `);
    // 网址快照表：消息里出现的 http(s) 链接被归档为「元数据卡片 + HTML 全文 + 截图」。
    // 一条消息可能含多个链接，故与 messages 是一对多。
    // status: ok（全部就绪）/ ok（部分成功，看各 path 是否为空）/ fetch_failed（连网页都没抓到）
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS link_snapshots (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        message_id INTEGER,
        url TEXT NOT NULL,
        final_url TEXT,
        title TEXT,
        description TEXT,
        site_name TEXT,
        domain TEXT,
        html_path TEXT,
        cover_path TEXT,
        screenshot_path TEXT,
        status TEXT,
        error TEXT,
        created_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_link_msg ON link_snapshots(message_id);
      CREATE INDEX IF NOT EXISTS idx_link_created ON link_snapshots(created_at);
    `);
    // 兼容旧库：补齐 kind / voice / media / filename 列
    for (const col of ['kind', 'voice', 'media', 'filename']) {
      try {
        this.db.exec(`ALTER TABLE messages ADD COLUMN ${col} TEXT`);
      } catch {
        /* 已存在 */
      }
    }
    // 按通道串行化 聊天.xlsx 的追加写，避免同一通道并发读写导致丢行/损坏
    this._chatQueue = new Map();
  }

  // FUN-4：数据库一致性快照。库运行在 WAL 模式，直接拷贝 archive.db 会丢掉
  // 未 checkpoint 的 -wal 内容；better-sqlite3 的 backup() 走 SQLite 在线备份 API，
  // 备份期间不阻塞正常读写，落出的是一个完整自包含的 db 文件（无需 -wal/-shm）。
  async backup(destPath) {
    await this.db.backup(destPath);
    return destPath;
  }

  static isChat(kind) {
    return kind === 'text' || kind === 'voice';
  }

  _chatFile(channelName) {
    return path.join(this.archiveRoot, Storage.safe(channelName), '聊天.xlsx');
  }

  _voiceDir(channelName) {
    return path.join(this.archiveRoot, Storage.safe(channelName), '语音');
  }

  static safe(name) {
    return String(name || '未知')
      .replace(/[\\/:*?"<>|]/g, '_')
      .replace(/\s+/g, '_')
      .slice(0, 60);
  }

  // 媒体相对路径统一用正斜杠（与平台无关），保证落盘与迁移查找一致
  static _posix(...parts) {
    return parts.join('/');
  }

  _relPath(channelName, category, sub) {
    const parts = [Storage.safe(channelName), Storage.safe(category)];
    if (sub) parts.push(Storage.safe(sub));
    return path.join(...parts);
  }

  _fileStamp(ts) {
    const d = new Date(ts);
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  }

  // 保存一条消息：写 SQLite；真正的媒体文件由 saveMedia 按类型落盘到 图片/文件/视频/语音 目录，
  // 不再为每条消息生成 Markdown 卡片（用户需在飞牛文件管理器中直接预览原文件）。
  // 聊天类(纯文本/语音)引用该通道的 聊天.xlsx。
  // 预编译语句缓存：按 SQL 文本复用 Statement。
  //
  // 为什么需要：此前每处都是 `this.db.prepare(sql).run(...)` —— 即用即弃。
  // 这些临时 Statement 调用完就变成垃圾，一旦被 GC 析构，在 Node 24 上配合
  // better-sqlite3 11.10 会命中原生断言 Assertion failed: (env) != nullptr
  // （RemoveEnvironmentCleanupHook ← Statement::~Statement）直接中止进程。
  // 缓存后语句常驻引用，不会被 GC 析构；顺带省掉每次重复解析 SQL 的开销
  // （saveMessage / listMessages 是高频路径，收益明显）。
  //
  // 缓存规模是有界的：SQL 变体只由"用了哪些筛选条件"决定，
  // 条件值一律用 ? 绑定、不拼进 SQL，因此组合数是有限的小规模集合。
  _stmt(sql) {
    let s = this._stmts.get(sql);
    if (!s) {
      s = this.db.prepare(sql); // 注意：这里必须是 db.prepare，不能递归回 _stmt
      this._stmts.set(sql, s);
    }
    return s;
  }

  saveMessage({ channelId, channelName, peer, text, kind = '', category = '未分类', sub = '', voice = '', media = '', filename = '' }) {
    const ts = Date.now();
    // 微信表情占位符（如 [裂开]）：若整条文本只是表情、且未被显式标记为媒体类型，
    // 则归入「表情」类型（emoji），而非普通文本——这样分类 / 统计 / 样式都按表情处理。
    let effectiveKind = kind;
    if ((!effectiveKind || effectiveKind === 'text') && isPureEmojiText(text)) {
      effectiveKind = 'emoji';
    } else if (!effectiveKind) {
      // 未显式给定类型（纯文本消息）统一规整为 'text'，
      // 否则会落库为 ''，既无法命中「文本」筛选，也不利于统计。
      effectiveKind = 'text';
    }
    const chat = Storage.isChat(effectiveKind);
    const fpath = chat ? this._chatFile(channelName) : ''; // 非聊天类：path 留空，主文件由 saveMedia 落盘

    const info = {
      channel_id: channelId,
      channel_name: channelName,
      peer: peer || '',
      ts,
      category,
      sub,
      text,
      kind: effectiveKind,
      path: fpath,
      voice: voice || '',
      media: media || '',
      filename: filename || '',
      created_at: ts,
    };
    const r = this._stmt(
        'INSERT INTO messages (channel_id, channel_name, peer, ts, category, sub, text, kind, path, voice, media, filename, created_at) VALUES (@channel_id, @channel_name, @peer, @ts, @category, @sub, @text, @kind, @path, @voice, @media, @filename, @created_at)',
      )
      .run(info);
    return { id: Number(r.lastInsertRowid), ...info };
  }

  // 聊天类消息的语音音频相对路径（用于 Web 播放/下载），在音频落盘后回填
  setVoice(id, rel) {
    this._stmt('UPDATE messages SET voice=? WHERE id=?').run(rel || '', id);
  }

  // 媒体（图片/文件/视频/表情）相对路径回填，落盘后调用
  setMedia(id, rel) {
    this._stmt('UPDATE messages SET media=? WHERE id=?').run(rel || '', id);
  }

  // 重新分类：媒体文件按类型固定落在 图片/文件/视频/语音 目录（由 kind 决定，不随语义分类移动），
  // 因此非聊天类只需更新 SQLite 的 category/sub 标签；聊天类同理只更新索引。
  reclassify(id, category, sub = '') {
    const row = this._stmt('SELECT * FROM messages WHERE id=?').get(id);
    if (!row) return null;
    this._stmt('UPDATE messages SET category=?, sub=? WHERE id=?').run(category, sub, id);
    return this.getMessage(id);
  }

  // 旧数据迁移：把早期版本统一存到 [通道]/媒体/ 的真实文件，按类型移动到 图片/文件/视频/语音 目录，
  // 并清理各分类目录遗留的 Markdown 卡片。幂等、可重复执行。返回迁移统计。
  // 需在消息已入库（messages.media 指向旧 媒体/ 路径）后调用。
  migrateOldMedia() {
    const stats = { moved: 0, deduped: 0, cardsRemoved: 0, scanned: 0 };
    if (!fs.existsSync(this.archiveRoot)) return stats;
    for (const ch of fs.readdirSync(this.archiveRoot)) {
      const chDir = path.join(this.archiveRoot, ch);
      if (!fs.statSync(chDir).isDirectory()) continue;
      const oldMediaDir = path.join(chDir, '媒体');
      // 1) 迁移 媒体/ 下的真实文件
      if (fs.existsSync(oldMediaDir) && fs.statSync(oldMediaDir).isDirectory()) {
        for (const fname of fs.readdirSync(oldMediaDir)) {
          const oldAbs = path.join(oldMediaDir, fname);
          if (!fs.statSync(oldAbs).isFile()) continue;
          stats.scanned += 1;
          // 在 DB 中找指向该旧路径的消息（rel 用正斜杠，与落盘一致）
          const rel = Storage._posix(ch, '媒体', fname);
          const row = this._stmt('SELECT * FROM messages WHERE media=?').get(rel);
          const kind = row?.kind || '';
          // 去重：若同通道已有内容相同的文件，直接复用
          let buf = null;
          try {
            buf = fs.readFileSync(oldAbs);
          } catch {
            continue;
          }
          const hash = crypto.createHash('sha256').update(buf).digest('hex').slice(0, 32);
          const dup = this._findDup(ch, hash);
          if (dup) {
            // 已存在相同文件：删除旧的，把 DB 指向复用文件
            try {
              fs.unlinkSync(oldAbs);
            } catch {
              /* ignore */
            }
            if (row) this._stmt('UPDATE messages SET media=? WHERE id=?').run(dup, row.id);
            stats.deduped += 1;
            continue;
          }
          const catDir = Storage.catDirForKind(kind);
          const newDir = path.join(chDir, catDir);
          fs.mkdirSync(newDir, { recursive: true });
          const newAbs = this._uniquePath(newDir, fname);
          try {
            fs.renameSync(oldAbs, newAbs);
          } catch {
            // 跨设备 rename 失败时退回 copy+unlink
            try {
              fs.copyFileSync(oldAbs, newAbs);
              fs.unlinkSync(oldAbs);
            } catch {
              continue;
            }
          }
          const newRel = Storage._posix(ch, catDir, path.basename(newAbs));
          this._recordHash(hash, newRel, ch);
          if (row) this._stmt('UPDATE messages SET media=? WHERE id=?').run(newRel, row.id);
          stats.moved += 1;
        }
        // 清理空的 媒体/ 目录
        try {
          if (fs.readdirSync(oldMediaDir).length === 0) fs.rmdirSync(oldMediaDir);
        } catch {
          /* ignore */
        }
      }
      // 2) 删除遗留的 Markdown 卡片（早期每条消息一个 .md，已无意义）
      this._removeLegacyCards(chDir, stats);
    }
    return stats;
  }

  // 删除目录树中遗留的 ClawVault Markdown 卡片（以固定标题开头），保留 聊天.xlsx 等非卡片文件
  _removeLegacyCards(dir, stats) {
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const abs = path.join(dir, e.name);
      try {
        if (e.isDirectory()) {
          this._removeLegacyCards(abs, stats);
        } else if (e.isFile() && e.name.endsWith('.md')) {
          try {
            const head = fs.readFileSync(abs, 'utf8').slice(0, 40);
            if (head.includes('ClawVault 对话归档')) {
              fs.unlinkSync(abs);
              stats.cardsRemoved += 1;
            }
          } catch {
            /* ignore */
          }
        }
      } catch {
        /* ignore */
      }
    }
  }

  getMessage(id) {
    const row = this._stmt('SELECT * FROM messages WHERE id=?').get(id);
    return row ? this._map(row) : null;
  }

  // 下载外部媒体（SEC-02）。
  // media.url 来自 provider 归一化结果，可能是攻击者可控的值。此前这里直接
  // `fetch(media.url)`：既无 SSRF 校验（可打 169.254.169.254 云元数据 / 内网服务），
  // 也无超时与体积上限，而抓取到的内容会落盘并可通过 /api/media/:id 读回来——
  // 等于一个**带响应回显**的 SSRF。这里统一走 netguard：先校验目标、钉住解析结果
  // （防 DNS Rebinding），再限时限量下载。
  async _downloadMedia(url) {
    await assertPublicUrl(url);
    return downloadToBuffer(url, { timeoutMs: 30000, maxBytes: 64 * 1024 * 1024 });
  }

  // 保存语音音频：下载/解密/转码后写入 [通道]/语音/<时间戳>.<ext>，返回相对归档根路径（或原 URL）。
  // media: { url?: string, buffer?: Buffer, ext?: string, aesKey?: string }
  // iLink 加密语音做 AES-128-ECB 解密；对 SILK/AMR 等浏览器不支持的格式转码为 MP3/WAV。
  async saveVoiceFile({ channelName, media }) {
    if (!media) return '';
    const dir = this._voiceDir(channelName);
    fs.mkdirSync(dir, { recursive: true });
    const stamp = this._fileStamp(Date.now());
    try {
      let buf;
      if (media.buffer) buf = media.buffer;
      else if (media.url) {
        buf = await this._downloadMedia(media.url);
      } else return '';
      // iLink 加密语音：AES-128-ECB 解密（已是音频头则跳过，兼容明文来源）
      if (media.aesKey && !isMediaHeader(buf)) buf = decryptIlink(buf, media.aesKey);
      // 转码成浏览器可播放格式（SILK→WAV、AMR→MP3；MP3/WAV/OGG 等直接透传）
      const transcoded = await transcodeVoice(buf, media.ext);
      const safeExt = String(transcoded.ext).replace(/[^\w]/g, '').slice(0, 8) || 'mp3';
      const fname = `${stamp}-${crypto.randomBytes(3).toString('hex')}.${safeExt}`;
      const fpath = path.join(dir, fname);
      fs.writeFileSync(fpath, transcoded.buffer);
      return path.join(Storage.safe(channelName), '语音', fname);
    } catch (e) {
      console.error('[ClawVault] 保存语音失败:', e?.message || e);
      return media.url || '';
    }
  }

  // 重命名通道：更新 DB 的 channel_name、重写 path/media/voice 中的旧文件夹前缀，并物理重命名归档文件夹。
  // 返回是否重命名了磁盘文件夹。
  renameChannel({ channelId, oldName, newName }) {
    const oldSafe = Storage.safe(oldName);
    const newSafe = Storage.safe(newName);
    this._stmt('UPDATE messages SET channel_name=? WHERE channel_id=?').run(newName, channelId);
    if (oldSafe === newSafe) return false;
    const like = oldSafe + '/';
    for (const col of ['path', 'media', 'voice']) {
      this._stmt(`UPDATE messages SET ${col} = REPLACE(${col}, ?, ?) WHERE channel_id=? AND ${col} LIKE ?`)
        .run(oldSafe + '/', newSafe + '/', channelId, like + '%');
    }
    try {
      const from = path.join(this.archiveRoot, oldSafe);
      const to = path.join(this.archiveRoot, newSafe);
      if (fs.existsSync(from)) fs.renameSync(from, to);
    } catch (e) {
      console.error('[ClawVault] 重命名归档文件夹失败:', e?.message || e);
    }
    return true;
  }

  // 向 [通道]/聊天.xlsx 追加一行（纯文本/语音聊天记录）
  // 同一通道的多次追加串行执行，避免并发读写 xlsx 损坏或丢行
  appendChatRow({ channelName, row }) {
    const key = Storage.safe(channelName);
    const prev = this._chatQueue.get(key) || Promise.resolve();
    const run = () => this._appendChatRow(channelName, row);
    const next = prev.then(run, run);
    this._chatQueue.set(key, next);
    next.finally(() => {
      if (this._chatQueue.get(key) === next) this._chatQueue.delete(key);
    });
    return next;
  }

  // 聊天.xlsx 的表头定义：新建与重建共用，保证删除消息后重写的文件列序一致
  static _chatColumns() {
    return [
      { header: '时间', key: 'ts', width: 20 },
      { header: '通道', key: 'channel', width: 18 },
      { header: '分类', key: 'category', width: 10 },
      { header: '子分类', key: 'sub', width: 12 },
      { header: '会话', key: 'peer', width: 16 },
      { header: '文字', key: 'text', width: 60 },
      { header: '语音', key: 'voice', width: 34 },
    ];
  }

  async _appendChatRow(channelName, row) {
    const file = this._chatFile(channelName);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const wb = new ExcelJS.Workbook();
    let ws;
    if (fs.existsSync(file)) {
      await wb.xlsx.readFile(file);
      ws = wb.worksheets[0];
    } else {
      ws = wb.addWorksheet('聊天');
      ws.columns = Storage._chatColumns();
    }
    const t = new Date(row.ts || Date.now());
    const pad = (n) => String(n).padStart(2, '0');
    const time = `${t.getFullYear()}-${pad(t.getMonth() + 1)}-${pad(t.getDate())} ${pad(t.getHours())}:${pad(t.getMinutes())}:${pad(t.getSeconds())}`;
    this._addChatRow(ws, { ...row, channel: row.channel || channelName });
    await wb.xlsx.writeFile(file);
    return file;
  }

  // 写入一行聊天记录（时间格式化 + 语音超链接），追加与重建共用
  _addChatRow(ws, row) {
    const t = new Date(row.ts || Date.now());
    const pad = (n) => String(n).padStart(2, '0');
    const time = `${t.getFullYear()}-${pad(t.getMonth() + 1)}-${pad(t.getDate())} ${pad(t.getHours())}:${pad(t.getMinutes())}:${pad(t.getSeconds())}`;
    const added = ws.addRow([time, row.channel || '', row.category || '', row.sub || '', row.peer || '', row.text || '', row.voice || '']);
    // 语音列：本地音频文件 → 超链接到绝对路径
    if (row.voice && String(row.voice).includes('语音')) {
      const abs = path.join(this.archiveRoot, row.voice);
      added.getCell(7).value = { text: '🎧 听音频', hyperlink: `file://${abs}` };
    }
    return added;
  }

  // 删除消息后按 SQLite 现状整体重写该通道的 聊天.xlsx，使导出与索引一致。
  // 走与追加写同一个串行队列，避免并发追加时读写打架。
  rebuildChat(channelName) {
    const key = Storage.safe(channelName);
    const prev = this._chatQueue.get(key) || Promise.resolve();
    const run = () => this._rebuildChat(channelName);
    const next = prev.then(run, run);
    this._chatQueue.set(key, next);
    next.finally(() => {
      if (this._chatQueue.get(key) === next) this._chatQueue.delete(key);
    });
    return next;
  }

  async _rebuildChat(channelName) {
    const file = this._chatFile(channelName);
    const rows = this._stmt("SELECT * FROM messages WHERE channel_name=? AND kind IN ('text','voice') ORDER BY ts ASC")
      .all(channelName);
    if (!rows.length) {
      // 该通道已无聊天记录：删掉空壳 xlsx，让侧栏归档列表同步消失
      try {
        if (fs.existsSync(file)) fs.unlinkSync(file);
      } catch {
        /* ignore */
      }
      return false;
    }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('聊天');
    ws.columns = Storage._chatColumns();
    for (const r of rows) {
      this._addChatRow(ws, {
        ts: r.ts,
        channel: r.channel_name,
        category: r.category,
        sub: r.sub,
        peer: r.peer,
        text: r.text,
        voice: r.voice || '',
      });
    }
    await wb.xlsx.writeFile(file);
    return true;
  }

  // 删除一条归档记录，并同步清理磁盘与导出：
  //   1) 删除 SQLite 记录
  //   2) 其 media/voice 文件若已无其他消息引用（去重表可能让多条消息指向同一文件）则物理删除
  //   3) 聊天类消息：按剩余记录重写该通道 聊天.xlsx
  // 返回 { id, removedFiles, xlsxRebuilt }；id 不存在返回 null。
  async deleteMessage(id) {
    const row = this._stmt('SELECT * FROM messages WHERE id=?').get(id);
    if (!row) return null;

    this._stmt('DELETE FROM messages WHERE id=?').run(id);

    let removedFiles = 0;
    const root = path.resolve(this.archiveRoot);
    for (const rel of [row.media, row.voice]) {
      if (!rel || /^https?:\/\//.test(String(rel))) continue; // 外链不删
      const stillUsed = this._stmt('SELECT COUNT(*) AS c FROM messages WHERE media=? OR voice=?')
        .get(rel, rel).c;
      if (stillUsed > 0) continue; // 去重后被其他消息引用
      const abs = path.resolve(this.archiveRoot, rel);
      if (abs !== root && !abs.startsWith(root + path.sep)) continue; // 越界保护
      try {
        if (fs.existsSync(abs)) {
          fs.unlinkSync(abs);
          removedFiles += 1;
        }
      } catch (e) {
        console.error('[ClawVault] 删除归档文件失败:', e?.message || e);
      }
      try {
        this._stmt('DELETE FROM media_hashes WHERE rel=?').run(rel);
      } catch {
        /* 去重表清理失败不影响主流程 */
      }
    }

    let xlsxRebuilt = false;
    if (Storage.isChat(row.kind)) {
      try {
        xlsxRebuilt = await this.rebuildChat(row.channel_name);
      } catch (e) {
        console.error('[ClawVault] 重写聊天.xlsx 失败:', e?.message || e);
      }
    }
    return { id, removedFiles, xlsxRebuilt };
  }

  // 媒体类型 → 落盘目录（按类型而非语义分类，方便飞牛相册/文件管理器直接预览）
  static catDirForKind(kind) {
    switch (String(kind).toLowerCase()) {
      case 'file':
      case 'document':
        return '文件';
      case 'video':
      case 'short_video':
        return '视频';
      case 'image':
      case 'photo':
      case 'picture':
      case 'sticker':
      case 'emoji':
      case 'gif':
        return '图片';
      default:
        return '媒体';
    }
  }

  // 媒体文件名：文件类保留原始文件名（去扩展名），图片/视频类用消息文字摘要做后缀
  _mediaBaseName({ kind, text, filename }) {
    const stamp = this._fileStamp(Date.now());
    if ((kind === 'file' || kind === 'document') && filename) {
      const dot = filename.lastIndexOf('.');
      const nameOnly = dot > 0 ? filename.slice(0, dot) : filename;
      const s = Storage.safe(nameOnly).replace(/_+/g, '_').slice(0, 50);
      return `${stamp}-${s || '文件'}`;
    }
    // 图片/视频：取文字摘要（去空白与标点，最多 16 字），无文字则回落「媒体」
    const summary = String(text || '')
      .replace(/[\s\p{P}\p{S}]+/gu, '')
      .slice(0, 16);
    const s = Storage.safe(summary || '媒体').replace(/_+/g, '_').slice(0, 50);
    return `${stamp}-${s}`;
  }

  // 同目录内避免重名覆盖：已存在则在基名后追加 _1 _2 …
  _uniquePath(dir, fname) {
    let p = path.join(dir, fname);
    if (!fs.existsSync(p)) return p;
    const ext = path.extname(fname);
    const base = fname.slice(0, -ext.length);
    let i = 1;
    do {
      p = path.join(dir, `${base}_${i}${ext}`);
      i += 1;
    } while (fs.existsSync(p));
    return p;
  }

  // 去重：同通道内内容相同的文件只存一份。返回已存在文件的相对路径（无则空串）
  _findDup(channelName, hash) {
    const row = this._stmt('SELECT rel FROM media_hashes WHERE channel_name=? AND hash=?')
      .get(channelName, hash);
    if (row && fs.existsSync(path.resolve(this.archiveRoot, row.rel))) return row.rel;
    return '';
  }

  _recordHash(hash, rel, channelName) {
    try {
      this._stmt('INSERT OR REPLACE INTO media_hashes (hash, rel, channel_name) VALUES (?,?,?)')
        .run(hash, rel, channelName);
    } catch {
      /* 去重表写入失败不影响主流程 */
    }
  }

  // 保存图片 / 文件 / 视频 / 表情等媒体：按类型落盘到 [通道]/<类型目录>/<可读名>.<ext>，
  // 内容去重（同通道 SHA-256 相同则复用已存文件，不重复占用空间）。
  // 返回相对归档根路径（下载/解析失败则记录日志并返回空串，不阻断主流程）。
  // media: { url?: string, buffer?: Buffer, ext?: string, aesKey?: string }
  // 若带 aesKey（iLink 加密媒体），下载/写入后做 AES-128-ECB 解密，并按真实文件头判定扩展名。
  async saveMedia({ channelName, id, media, kind = '', text = '' }) {
    if (!media) return '';
    try {
      let buf;
      if (media.buffer) {
        buf = media.buffer;
      } else if (media.url) {
        // SEC-02：走 netguard 的校验 + 钉 IP + 限时限量下载（原先是裸 fetch）
        buf = await this._downloadMedia(media.url);
      } else {
        return '';
      }
      // iLink 加密媒体：AES-128-ECB 解密（已是可识别媒体头则跳过，兼容明文来源）
      if (media.aesKey && !isMediaHeader(buf)) {
        buf = decryptIlink(buf, media.aesKey);
      }
      // 去重：同通道内内容相同的文件只存一份
      const hash = crypto.createHash('sha256').update(buf).digest('hex').slice(0, 32);
      const dup = this._findDup(channelName, hash);
      if (dup) return dup;

      // 扩展名：优先用解密后真实文件头判定，其次回落 media.ext / URL 后缀
      const urlPath = media.url ? media.url.split('?')[0] : '';
      let ext =
        detectMediaExt(buf) ||
        media.ext ||
        (urlPath && path.extname(urlPath).slice(1)) ||
        'bin';
      // ZIP 家族例外：xlsx / docx / pptx / apk / jar… 的容器都是 ZIP，
      // 魔数只能探到容器层，一律返回 'zip'。若照搬魔数结果落盘，
      // 「汇总.xlsx」会存成「汇总.zip」——文件管理器里看不出真实类型，
      // 按扩展名分发的预览 / 转换也会全部落空（这正是 v1.0.31 预览失效的根因）。
      // 因此探到 zip 时，只要原始文件名带了明确扩展名，就以原始名为准。
      // 图片 / 音视频等魔数能精确定位的类型不受影响，仍以魔数为准。
      if (ext === 'zip') {
        const nameExt = media.filename ? path.extname(media.filename).slice(1).toLowerCase() : '';
        if (nameExt) ext = nameExt;
      }
      const safeExt = String(ext).replace(/[^\w]/g, '').slice(0, 8) || 'bin';
      const base = this._mediaBaseName({ kind, text, filename: media.filename });
      const catDir = Storage.catDirForKind(kind);
      const dir = path.join(this.archiveRoot, Storage.safe(channelName), catDir);
      fs.mkdirSync(dir, { recursive: true });
      const fpath = this._uniquePath(dir, `${base}.${safeExt}`);
      fs.writeFileSync(fpath, buf);
      const rel = Storage._posix(Storage.safe(channelName), catDir, path.basename(fpath));
      this._recordHash(hash, rel, channelName);
      return rel;
    } catch (e) {
      console.error('[ClawVault] 媒体落盘失败:', e?.message || e);
      return '';
    }
  }

  _map(row) {
    return {
      id: row.id,
      channelId: row.channel_id,
      channelName: row.channel_name,
      peer: row.peer,
      ts: row.ts,
      category: row.category,
      sub: row.sub,
      text: row.text,
      kind: row.kind,
      path: row.path,
      voice: row.voice || '',
      media: row.media || '',
      filename: row.filename || '',
    };
  }

  // 聊天.xlsx 的绝对路径（按通道名）
  chatFileFor(channelName) {
    return this._chatFile(channelName);
  }

  // 列出各通道的聊天归档（用于 Web UI 下载入口）
  listChatArchives() {
    const root = this.archiveRoot;
    if (!fs.existsSync(root)) return [];
    const out = [];
    for (const ch of fs.readdirSync(root)) {
      const xlsx = path.join(root, ch, '聊天.xlsx');
      if (!fs.existsSync(xlsx)) continue;
      const r1 = this._stmt("SELECT COUNT(*) AS c FROM messages WHERE channel_name=? AND kind IN ('text','voice')")
        .get(ch);
      const r2 = this._stmt("SELECT COUNT(*) AS c FROM messages WHERE channel_name=? AND voice IS NOT NULL AND voice != ''")
        .get(ch);
      let size = 0;
      try {
        size = fs.statSync(xlsx).size;
      } catch {
        /* ignore */
      }
      out.push({
        channel: ch,
        rows: r1?.c || 0,
        hasVoice: (r2?.c || 0) > 0,
        size,
        downloadUrl: `/api/chats/${encodeURIComponent(ch)}/xlsx`,
      });
    }
    return out;
  }

  // 一次性把历史数据中「整条仅含微信表情占位符」的文本消息重新归类为表情类型。
  // 幂等：已为 emoji 的不重复处理；只扫描原本是 text/空 kind 的记录。返回受影响条数。
  reclassifyEmojis() {
    const rows = this._stmt("SELECT id, text FROM messages WHERE kind = '' OR kind = 'text'")
      .all();
    let n = 0;
    for (const r of rows) {
      if (isPureEmojiText(r.text)) {
        this._stmt("UPDATE messages SET kind = 'emoji' WHERE id = ?").run(r.id);
        n += 1;
      }
    }
    return n;
  }

  // 存量数据迁移：v1.0.32 起文本消息归入「文本消息」大类（配了 AI 才细分到子分类）。
  // 更早版本在「未配置 AI」时把文本留在「未分类」，升级后这些存量行仍会挂在「未分类」下，
  // 看起来像新规则没生效。这里一次性把它们归位：
  //   kind=text  → 文本消息；kind=emoji（含纯表情文本） → 表情。
  // 只处理 category 仍为「未分类」的行，幂等、可重复执行；无存量时是空操作。
  migrateUncategorizedText() {
    const text = this._stmt("UPDATE messages SET category = '文本消息', sub = '' WHERE category = '未分类' AND kind = 'text'")
      .run().changes;
    const emoji = this._stmt("UPDATE messages SET category = '表情', sub = '' WHERE category = '未分类' AND kind = 'emoji'")
      .run().changes;
    return { text, emoji };
  }

  // 统计某个会话自 sinceTs（毫秒时间戳）起、按消息类型分组的数量。
  // 归档回执用它取"当天累计"口径，避免重启或跨批次导致计数漂移。
  countMessagesByKindSince(channelId, peer, sinceTs) {
    const rows = this._stmt(
      'SELECT kind, COUNT(*) AS c FROM messages WHERE channel_id = ? AND peer = ? AND ts >= ? GROUP BY kind',
    ).all(channelId, peer, sinceTs);
    const out = {};
    for (const r of rows) {
      const k = r.kind || 'text';
      out[k] = (out[k] || 0) + r.c;
    }
    return out;
  }

  // 列表查询（支持通道/分类/子分类/类型/搜索过滤 + 分页）
  // kind 支持逗号分隔的多个值（如 "sticker,emoji"），用于「表情」筛选同时覆盖贴纸与文字表情。
  listMessages({ channelId, category, sub, kind, q, limit = 50, offset = 0 } = {}) {
    const where = [];
    const params = {};
    if (channelId) {
      where.push('channel_id = @channelId');
      params.channelId = channelId;
    }
    if (category) {
      where.push('category = @category');
      params.category = category;
    }
    if (sub !== undefined && sub !== null) {
      where.push('sub = @sub');
      params.sub = sub;
    }
    if (kind) {
      const list = String(kind).split(',').map((s) => s.trim()).filter(Boolean);
      if (list.length === 1) {
        where.push('kind = @kind');
        params.kind = list[0];
      } else {
        const ph = list.map((_, i) => `@kind${i}`).join(',');
        where.push(`kind IN (${ph})`);
        list.forEach((k, i) => {
          params[`kind${i}`] = k;
        });
      }
    }
    if (q) {
      where.push("text LIKE @q ESCAPE '\\'");
      params.q = `%${escapeLike(q)}%`;
    }
    const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const rows = this._stmt(`SELECT * FROM messages ${w} ORDER BY ts DESC LIMIT @limit OFFSET @offset`)
      .all({ ...params, limit, offset });
    const total = this._stmt(`SELECT COUNT(*) AS c FROM messages ${w}`).get(params).c;
    return { total, items: rows.map((r) => this._map(r)) };
  }

  // 分类文件夹树：按 通道 → 分类 → 子分类 聚合
  getFolders() {
    const rows = this._stmt(
        'SELECT channel_name, category, sub, COUNT(*) AS cnt FROM messages GROUP BY channel_name, category, sub ORDER BY channel_name, category, sub',
      )
      .all();
    const tree = {};
    for (const r of rows) {
      const ch = r.channel_name;
      const cat = r.category;
      const sub = r.sub || '';
      tree[ch] = tree[ch] || { name: ch, categories: {} };
      tree[ch].categories[cat] = tree[ch].categories[cat] || { name: cat, count: 0, subs: {} };
      tree[ch].categories[cat].count += r.cnt;
      if (sub) {
        tree[ch].categories[cat].subs[sub] = (tree[ch].categories[cat].subs[sub] || 0) + r.cnt;
      }
    }
    return Object.values(tree).map((ch) => ({
      name: ch.name,
      categories: Object.values(ch.categories).map((c) => ({
        name: c.name,
        count: c.count,
        subs: Object.entries(c.subs).map(([s, n]) => ({ name: s, count: n })),
      })),
    }));
  }

  count() {
    return this._stmt('SELECT COUNT(*) AS c FROM messages').get().c;
  }

  // 运行状况统计：总数、按类型分布、按分类分布、媒体缺口（应存媒体却未落盘）
  stats() {
    const total = this.count();
    const byKindRows = this._stmt('SELECT kind, COUNT(*) AS c FROM messages GROUP BY kind').all();
    const byKind = {};
    for (const r of byKindRows) byKind[r.kind || 'unknown'] = r.c;
    const catRows = this._stmt('SELECT category, COUNT(*) AS c FROM messages GROUP BY category ORDER BY c DESC')
      .all();
    const byCategory = catRows.map((r) => ({ category: r.category, count: r.c }));
    // 这些类型应通过 saveMedia 落盘；若 media 为空即为"缺口"（照片缺失的根因信号）
    const mediaKinds = ['image', 'video', 'file', 'sticker', 'gif', 'picture', 'photo', 'short_video', 'document'];
    const gaps = this._stmt(`SELECT COUNT(*) AS c FROM messages WHERE kind IN (${mediaKinds.map(() => '?').join(',')}) AND (media IS NULL OR media = '')`)
      .get(...mediaKinds).c;
    const stored = this._stmt("SELECT COUNT(*) AS c FROM messages WHERE media IS NOT NULL AND media != ''").get().c;
    return { total, byKind, byCategory, mediaGaps: gaps, mediaStored: stored };
  }

  // ---- 网址快照（消息里的链接被归档为 元数据卡片 + HTML 全文 + 截图）----

  // 保存一条链接快照。rec 由 linkshot.createSnapshot 产出，这里补齐 messageId 落库。
  saveLinkSnapshot(rec) {
    const info = {
      message_id: rec.messageId ?? null,
      url: rec.url || '',
      final_url: rec.finalUrl || rec.url || '',
      title: rec.title || '',
      description: rec.description || '',
      site_name: rec.siteName || '',
      domain: rec.domain || '',
      html_path: rec.htmlPath || '',
      cover_path: rec.coverPath || '',
      screenshot_path: rec.screenshotPath || '',
      status: rec.status || 'ok',
      error: rec.error || '',
      created_at: rec.createdAt || Date.now(),
    };
    const r = this._stmt(
      `INSERT INTO link_snapshots
       (message_id, url, final_url, title, description, site_name, domain, html_path, cover_path, screenshot_path, status, error, created_at)
       VALUES
       (@message_id, @url, @final_url, @title, @description, @site_name, @domain, @html_path, @cover_path, @screenshot_path, @status, @error, @created_at)`,
    ).run(info);
    return { id: Number(r.lastInsertRowid), ...info };
  }

  // 某条消息关联的全部快照（一条消息可含多个链接）
  getLinkSnapshots(messageId) {
    return this._stmt('SELECT * FROM link_snapshots WHERE message_id=? ORDER BY id').all(messageId);
  }

  getLinkSnapshot(id) {
    return this._stmt('SELECT * FROM link_snapshots WHERE id=?').get(id) || null;
  }

  // 重新抓取后更新已存在的快照行（按 id 原地更新，不新增行）。
  // rec 由 linkshot.createSnapshot 产出；id / messageId 由调用方补全，
  // 保证「重新抓取」按钮在 UI 里就地刷新同一条快照。
  updateLinkSnapshot(rec) {
    const info = {
      id: rec.id,
      final_url: rec.finalUrl || rec.url || '',
      title: rec.title || '',
      description: rec.description || '',
      site_name: rec.siteName || '',
      domain: rec.domain || '',
      html_path: rec.htmlPath || '',
      cover_path: rec.coverPath || '',
      screenshot_path: rec.screenshotPath || '',
      status: rec.status || 'ok',
      error: rec.error || '',
      created_at: rec.createdAt || Date.now(),
    };
    this._stmt(
      `UPDATE link_snapshots SET
         final_url=@final_url, title=@title, description=@description, site_name=@site_name,
         domain=@domain, html_path=@html_path, cover_path=@cover_path, screenshot_path=@screenshot_path,
         status=@status, error=@error, created_at=@created_at
       WHERE id=@id`,
    ).run(info);
    return this.getLinkSnapshot(rec.id);
  }

  // 「收藏网址」列表：按时间倒序，可按标题/摘要/域名/URL 关键词搜索。
  // 搜索沿用 escapeLike 转义 % _ \，否则搜「100%」会退化成全表匹配。
  listLinkSnapshots({ q = '', limit = 50, offset = 0 } = {}) {
    const kw = String(q || '').trim();
    const lim = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200);
    const off = Math.max(parseInt(offset, 10) || 0, 0);
    if (kw) {
      const like = `%${escapeLike(kw)}%`;
      const items = this._stmt(
        `SELECT * FROM link_snapshots
         WHERE title LIKE @like ESCAPE '\\'
            OR description LIKE @like ESCAPE '\\'
            OR domain LIKE @like ESCAPE '\\'
            OR url LIKE @like ESCAPE '\\'
         ORDER BY created_at DESC, id DESC LIMIT @lim OFFSET @off`,
      ).all({ like, lim, off });
      const total = this._stmt(
        `SELECT COUNT(*) AS c FROM link_snapshots
         WHERE title LIKE @like ESCAPE '\\'
            OR description LIKE @like ESCAPE '\\'
            OR domain LIKE @like ESCAPE '\\'
            OR url LIKE @like ESCAPE '\\'`,
      ).get({ like }).c;
      return { items, total };
    }
    const items = this._stmt(
      'SELECT * FROM link_snapshots ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?',
    ).all(lim, off);
    const total = this._stmt('SELECT COUNT(*) AS c FROM link_snapshots').get().c;
    return { items, total };
  }

  deleteLinkSnapshot(id) {
    this._stmt('DELETE FROM link_snapshots WHERE id=?').run(id);
  }
}
