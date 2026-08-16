import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import ExcelJS from 'exceljs';
import { decryptIlink, detectMediaExt } from './ilink_crypto.js';

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
    this.db.pragma('journal_mode = WAL');
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
        created_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_msgs_channel ON messages(channel_id);
      CREATE INDEX IF NOT EXISTS idx_msgs_cat ON messages(category, sub);
      CREATE INDEX IF NOT EXISTS idx_msgs_ts ON messages(ts);
    `);
    // 兼容旧库：补齐 kind / voice / media 列
    for (const col of ['kind', 'voice', 'media']) {
      try {
        this.db.exec(`ALTER TABLE messages ADD COLUMN ${col} TEXT`);
      } catch {
        /* 已存在 */
      }
    }
    // 按通道串行化 聊天.xlsx 的追加写，避免同一通道并发读写导致丢行/损坏
    this._chatQueue = new Map();
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

  _md({ ts, channelName, peer, category, sub, text }) {
    const t = new Date(ts).toLocaleString('zh-CN');
    const cat = sub ? `${category} / ${sub}` : category;
    // 标题与文案平台无关（同一套引擎服务微信/Telegram/飞书/Discord…），不再写死"微信"
    return `# ClawVault 对话归档\n\n- 时间：${t}\n- 通道：${channelName}\n- 对方：${peer || '我'}\n- 分类：${cat}\n\n---\n\n${text}\n`;
  }

  // 保存一条消息：写 SQLite；非聊天类(图片/文件…)同时落盘 Markdown，聊天类(纯文本/语音)不落 Markdown
  saveMessage({ channelId, channelName, peer, text, kind = '', category = '未分类', sub = '', voice = '', media = '' }) {
    const ts = Date.now();
    const chat = Storage.isChat(kind);
    let fpath = '';
    if (!chat) {
      const rel = this._relPath(channelName, category, sub);
      const dir = path.join(this.archiveRoot, rel);
      fs.mkdirSync(dir, { recursive: true });
      const fname = `${this._fileStamp(ts)}-${crypto.randomBytes(3).toString('hex')}.md`;
      fpath = path.join(dir, fname);
      fs.writeFileSync(fpath, this._md({ ts, channelName, peer, category, sub, text }));
    } else {
      fpath = this._chatFile(channelName); // 聊天类：引用该通道的 聊天.xlsx
    }

    const info = {
      channel_id: channelId,
      channel_name: channelName,
      peer: peer || '',
      ts,
      category,
      sub,
      text,
      kind,
      path: fpath,
      voice: voice || '',
      media: media || '',
      created_at: ts,
    };
    const r = this.db
      .prepare(
        'INSERT INTO messages (channel_id, channel_name, peer, ts, category, sub, text, kind, path, voice, media, created_at) VALUES (@channel_id, @channel_name, @peer, @ts, @category, @sub, @text, @kind, @path, @voice, @media, @created_at)',
      )
      .run(info);
    return { id: Number(r.lastInsertRowid), ...info };
  }

  // 聊天类消息的语音音频相对路径（用于 Web 播放/下载），在音频落盘后回填
  setVoice(id, rel) {
    this.db.prepare('UPDATE messages SET voice=? WHERE id=?').run(rel || '', id);
  }

  // 媒体（图片/文件/视频/表情）相对路径回填，落盘后调用
  setMedia(id, rel) {
    this.db.prepare('UPDATE messages SET media=? WHERE id=?').run(rel || '', id);
  }

  // 重新分类：聊天类只更新 SQLite 索引（不移动 Markdown）；其他类搬 Markdown 文件
  reclassify(id, category, sub = '') {
    const row = this.db.prepare('SELECT * FROM messages WHERE id=?').get(id);
    if (!row) return null;
    if (Storage.isChat(row.kind)) {
      this.db.prepare('UPDATE messages SET category=?, sub=? WHERE id=?').run(category, sub, id);
      return this.getMessage(id);
    }
    try {
      fs.unlinkSync(row.path);
    } catch {
      /* 文件可能已不存在 */
    }
    const rel = this._relPath(row.channel_name, category, sub);
    const dir = path.join(this.archiveRoot, rel);
    fs.mkdirSync(dir, { recursive: true });
    const fname = `${this._fileStamp(row.ts)}-${crypto.randomBytes(3).toString('hex')}.md`;
    const fpath = path.join(dir, fname);
    fs.writeFileSync(fpath, this._md({ ts: row.ts, channelName: row.channel_name, peer: row.peer, category, sub, text: row.text }));
    this.db.prepare('UPDATE messages SET category=?, sub=?, path=? WHERE id=?').run(category, sub, fpath, id);
    return this.getMessage(id);
  }

  getMessage(id) {
    const row = this.db.prepare('SELECT * FROM messages WHERE id=?').get(id);
    return row ? this._map(row) : null;
  }

  // 保存语音音频：下载/写入到 [通道]/语音/<时间戳>.<ext>，返回相对归档根路径（或原 URL）
  // media: { url?: string, buffer?: Buffer, ext?: string, aesKey?: string }
  // 若带 aesKey（iLink 加密媒体），下载/写入后做 AES-128-ECB 解密，并按真实文件头判定扩展名。
  async saveVoiceFile({ channelName, media }) {
    if (!media) return '';
    const dir = this._voiceDir(channelName);
    fs.mkdirSync(dir, { recursive: true });
    const stamp = this._fileStamp(Date.now());
    try {
      let buf;
      if (media.buffer) buf = media.buffer;
      else if (media.url) {
        const res = await fetch(media.url);
        if (!res.ok) throw new Error(`下载音频失败 ${res.status}`);
        buf = Buffer.from(await res.arrayBuffer());
      } else return '';
      // iLink 加密语音：AES-128-ECB 解密（已是音频头则跳过，兼容明文来源）
      if (media.aesKey && !isMediaHeader(buf)) buf = decryptIlink(buf, media.aesKey);
      // 扩展名：优先真实文件头判定，其次 media.ext / URL 后缀
      const urlPath = media.url ? media.url.split('?')[0] : '';
      const ext = detectMediaExt(buf) || media.ext || (urlPath && path.extname(urlPath).slice(1)) || 'mp3';
      const safeExt = String(ext).replace(/[^\w]/g, '').slice(0, 8) || 'mp3';
      const fname = `${stamp}-${crypto.randomBytes(3).toString('hex')}.${safeExt}`;
      const fpath = path.join(dir, fname);
      fs.writeFileSync(fpath, buf);
      return path.join(Storage.safe(channelName), '语音', fname);
    } catch {
      return media.url || '';
    }
  }

  // 重命名通道：更新 DB 的 channel_name、重写 path/media/voice 中的旧文件夹前缀，并物理重命名归档文件夹。
  // 返回是否重命名了磁盘文件夹。
  renameChannel({ channelId, oldName, newName }) {
    const oldSafe = Storage.safe(oldName);
    const newSafe = Storage.safe(newName);
    this.db.prepare('UPDATE messages SET channel_name=? WHERE channel_id=?').run(newName, channelId);
    if (oldSafe === newSafe) return false;
    const like = oldSafe + '/';
    for (const col of ['path', 'media', 'voice']) {
      this.db
        .prepare(`UPDATE messages SET ${col} = REPLACE(${col}, ?, ?) WHERE channel_id=? AND ${col} LIKE ?`)
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
      ws.columns = [
        { header: '时间', key: 'ts', width: 20 },
        { header: '通道', key: 'channel', width: 18 },
        { header: '分类', key: 'category', width: 10 },
        { header: '子分类', key: 'sub', width: 12 },
        { header: '会话', key: 'peer', width: 16 },
        { header: '文字', key: 'text', width: 60 },
        { header: '语音', key: 'voice', width: 34 },
      ];
    }
    const t = new Date(row.ts || Date.now());
    const pad = (n) => String(n).padStart(2, '0');
    const time = `${t.getFullYear()}-${pad(t.getMonth() + 1)}-${pad(t.getDate())} ${pad(t.getHours())}:${pad(t.getMinutes())}:${pad(t.getSeconds())}`;
    const added = ws.addRow([time, row.channel || channelName, row.category || '', row.sub || '', row.peer || '', row.text || '', row.voice || '']);
    // 语音列：本地音频文件 → 超链接到绝对路径
    if (row.voice && row.voice.includes('语音')) {
      const abs = path.join(this.archiveRoot, row.voice);
      const cell = added.getCell(7);
      cell.value = { text: '🎧 听音频', hyperlink: `file://${abs}` };
    }
    await wb.xlsx.writeFile(file);
    return file;
  }

  // 保存图片 / 文件 / 视频 / 表情等媒体：下载 URL 或写入 buffer 到 [通道]/媒体/<id>.<ext>，
  // 返回相对归档根路径（下载/解析失败则记录日志并返回空串，不阻断主流程）。
  // media: { url?: string, buffer?: Buffer, ext?: string, aesKey?: string }
  // 若带 aesKey（iLink 加密媒体），下载/写入后做 AES-128-ECB 解密，并按真实文件头判定扩展名。
  async saveMedia({ channelName, id, media }) {
    if (!media) return '';
    const dir = path.join(this.archiveRoot, Storage.safe(channelName), '媒体');
    fs.mkdirSync(dir, { recursive: true });
    try {
      let buf;
      if (media.buffer) {
        buf = media.buffer;
      } else if (media.url) {
        const res = await fetch(media.url);
        if (!res.ok) throw new Error(`下载媒体失败 ${res.status}`);
        buf = Buffer.from(await res.arrayBuffer());
      } else {
        return '';
      }
      // iLink 加密媒体：AES-128-ECB 解密（已是可识别媒体头则跳过，兼容明文来源）
      if (media.aesKey && !isMediaHeader(buf)) {
        buf = decryptIlink(buf, media.aesKey);
      }
      // 扩展名：优先用解密后真实文件头判定，其次回落 media.ext / URL 后缀
      const urlPath = media.url ? media.url.split('?')[0] : '';
      const ext =
        detectMediaExt(buf) ||
        media.ext ||
        (urlPath && path.extname(urlPath).slice(1)) ||
        'bin';
      const safeExt = String(ext).replace(/[^\w]/g, '').slice(0, 8) || 'bin';
      const fname = `${id}-${crypto.randomBytes(3).toString('hex')}.${safeExt}`;
      const fpath = path.join(dir, fname);
      fs.writeFileSync(fpath, buf);
      return path.join(Storage.safe(channelName), '媒体', fname);
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
      const r1 = this.db
        .prepare("SELECT COUNT(*) AS c FROM messages WHERE channel_name=? AND kind IN ('text','voice')")
        .get(ch);
      const r2 = this.db
        .prepare("SELECT COUNT(*) AS c FROM messages WHERE channel_name=? AND voice IS NOT NULL AND voice != ''")
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

  // 列表查询（支持通道/分类/子分类/类型/搜索过滤 + 分页）
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
      where.push('kind = @kind');
      params.kind = kind;
    }
    if (q) {
      where.push('text LIKE @q');
      params.q = `%${q}%`;
    }
    const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const rows = this.db
      .prepare(`SELECT * FROM messages ${w} ORDER BY ts DESC LIMIT @limit OFFSET @offset`)
      .all({ ...params, limit, offset });
    const total = this.db.prepare(`SELECT COUNT(*) AS c FROM messages ${w}`).get(params).c;
    return { total, items: rows.map((r) => this._map(r)) };
  }

  // 分类文件夹树：按 通道 → 分类 → 子分类 聚合
  getFolders() {
    const rows = this.db
      .prepare(
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
    return this.db.prepare('SELECT COUNT(*) AS c FROM messages').get().c;
  }

  // 运行状况统计：总数、按类型分布、按分类分布、媒体缺口（应存媒体却未落盘）
  stats() {
    const total = this.count();
    const byKindRows = this.db.prepare('SELECT kind, COUNT(*) AS c FROM messages GROUP BY kind').all();
    const byKind = {};
    for (const r of byKindRows) byKind[r.kind || 'unknown'] = r.c;
    const catRows = this.db
      .prepare('SELECT category, COUNT(*) AS c FROM messages GROUP BY category ORDER BY c DESC')
      .all();
    const byCategory = catRows.map((r) => ({ category: r.category, count: r.c }));
    // 这些类型应通过 saveMedia 落盘；若 media 为空即为"缺口"（照片缺失的根因信号）
    const mediaKinds = ['image', 'video', 'file', 'sticker', 'gif', 'picture', 'photo', 'short_video', 'document'];
    const gaps = this.db
      .prepare(`SELECT COUNT(*) AS c FROM messages WHERE kind IN (${mediaKinds.map(() => '?').join(',')}) AND (media IS NULL OR media = '')`)
      .get(...mediaKinds).c;
    const stored = this.db.prepare("SELECT COUNT(*) AS c FROM messages WHERE media IS NOT NULL AND media != ''").get().c;
    return { total, byKind, byCategory, mediaGaps: gaps, mediaStored: stored };
  }
}
