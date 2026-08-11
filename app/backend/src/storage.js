import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import ExcelJS from 'exceljs';

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
        created_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_msgs_channel ON messages(channel_id);
      CREATE INDEX IF NOT EXISTS idx_msgs_cat ON messages(category, sub);
      CREATE INDEX IF NOT EXISTS idx_msgs_ts ON messages(ts);
    `);
    // 兼容旧库：补齐 kind 列
    try {
      this.db.exec('ALTER TABLE messages ADD COLUMN kind TEXT');
    } catch {
      /* 已存在 */
    }
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
    return `# 微信对话归档\n\n- 时间：${t}\n- 通道：${channelName}\n- 对方：${peer || '我'}\n- 分类：${cat}\n\n---\n\n${text}\n`;
  }

  // 保存一条消息：写 SQLite；非聊天类(图片/文件…)同时落盘 Markdown，聊天类(纯文本/语音)不落 Markdown
  saveMessage({ channelId, channelName, peer, text, kind = '', category = '未分类', sub = '' }) {
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
      created_at: ts,
    };
    const r = this.db
      .prepare(
        'INSERT INTO messages (channel_id, channel_name, peer, ts, category, sub, text, kind, path, created_at) VALUES (@channel_id, @channel_name, @peer, @ts, @category, @sub, @text, @kind, @path, @created_at)',
      )
      .run(info);
    return { id: Number(r.lastInsertRowid), ...info };
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

  // 保存语音音频：下载/写入到 [通道]/语音/<时间戳>.<ext>，返回相对归档根的路径（或原 URL）
  // media: { url?: string, buffer?: Buffer, ext?: string }
  async saveVoiceFile({ channelName, media }) {
    if (!media) return '';
    const ext = (media.ext || (media.url && path.extname(media.url).slice(1)) || 'mp3').replace(/[^\w]/g, '');
    const stamp = this._fileStamp(Date.now());
    const fname = `${stamp}-${crypto.randomBytes(3).toString('hex')}.${ext || 'mp3'}`;
    const dir = this._voiceDir(channelName);
    fs.mkdirSync(dir, { recursive: true });
    const fpath = path.join(dir, fname);
    try {
      if (media.buffer) {
        fs.writeFileSync(fpath, media.buffer);
      } else if (media.url) {
        const res = await fetch(media.url);
        if (!res.ok) throw new Error(`下载音频失败 ${res.status}`);
        const buf = Buffer.from(await res.arrayBuffer());
        fs.writeFileSync(fpath, buf);
      } else {
        return '';
      }
      return path.join(Storage.safe(channelName), '语音', fname); // 相对归档根
    } catch {
      // 下载失败则至少保留原 URL 作为线索
      return media.url || '';
    }
  }

  // 向 [通道]/聊天.xlsx 追加一行（纯文本/语音聊天记录）
  async appendChatRow({ channelName, row }) {
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
    };
  }

  // 列表查询（支持通道/分类/子分类/搜索过滤 + 分页）
  listMessages({ channelId, category, sub, q, limit = 50, offset = 0 } = {}) {
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
}
