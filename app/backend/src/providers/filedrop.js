// 本地文件投递（File Drop）适配器
// 监控一个本地目录，把新建 / 已有的 .txt/.md 等文本文件作为一条消息投递到归档链路。
// 典型场景：本地 bot / 脚本把输出写到目录 → 自动归档。零外部依赖，长驻 fs.watch。
//
// 文件读取与 watcher 通过构造可注入（readFile / watch），便于离线单测；
// 生产默认使用真实 fs.readFileSync / fs.watch。
import fs from 'node:fs';
import path from 'node:path';
import { Provider } from './base.js';

const DEFAULT_PATTERNS = ['.txt', '.md', '.text', '.log'];

function matchExt(name, patterns) {
  const lower = String(name).toLowerCase();
  return patterns.some((p) => lower.endsWith(p.startsWith('.') ? p : '.' + p));
}

export class FileDropProvider extends Provider {
  constructor({ channel, readFile = null, watch = null } = {}) {
    super({ channel });
    this._readFile = readFile; // 注入，便于测试
    this._watch = watch; // 注入 fs.watch，便于测试（默认用真实 fs.watch）
    this._running = false;
    this._watcher = null;
    this._timers = new Set();
  }

  get _path() {
    return String(this.cfg.path || '').trim();
  }
  get _patterns() {
    if (!this.cfg.pattern) return DEFAULT_PATTERNS;
    return String(this.cfg.pattern)
      .split(/[,\s]+/)
      .map((s) => s.trim())
      .filter(Boolean);
  }
  get _recursive() {
    return this.cfg.recursive !== false; // 默认递归
  }
  get _deleteAfter() {
    return Boolean(this.cfg.delete_after);
  }
  get _encoding() {
    return this.cfg.encoding || 'utf-8';
  }

  _configured() {
    return Boolean(this._path);
  }

  async startLogin() {
    // 无需登录：目录存在即可视为已连接
    this.channel.loggedIn = this._configured();
    this.channel.needRescan = false;
    this.channel._emitStatus();
    return {};
  }

  resume() {
    if (this._configured()) {
      this.channel.loggedIn = true;
      this.channel.needRescan = false;
      this.start();
    } else {
      this.channel.loggedIn = false;
      this.channel.needRescan = true;
    }
  }

  start() {
    if (this._running || !this._configured()) return;
    fs.mkdirSync(this._path, { recursive: true });
    this._running = true;
    this._scanSync(); // 启动即归档已有文件
    const onEvent = (_e, fname) => {
      if (!fname) return;
      this._ingestLater(path.join(this._path, String(fname)));
    };
    try {
      this._watcher = this._watch
        ? this._watch(this._path, { recursive: this._recursive }, onEvent)
        : fs.watch(this._path, { recursive: this._recursive }, onEvent);
    } catch {
      this._watcher = null;
    }
  }

  stop() {
    this._running = false;
    if (this._watcher && typeof this._watcher.close === 'function') {
      try {
        this._watcher.close();
      } catch {
        /* ignore */
      }
    }
    this._watcher = null;
    for (const t of this._timers) clearTimeout(t);
    this._timers.clear();
  }

  // 读取并投递一个文件；返回是否成功投递
  async ingestFile(filePath) {
    const name = path.basename(filePath);
    if (!matchExt(name, this._patterns)) return false;
    let text;
    try {
      const read = this._readFile || ((p) => fs.readFileSync(p, this._encoding));
      text = String((await read(filePath)) ?? '');
    } catch {
      return false;
    }
    if (!text.trim()) return false;
    await this.channel.deliver({
      peer: name,
      text,
      kind: 'text',
      contextToken: '',
      ts: Date.now(),
      raw: { file: filePath },
    });
    if (this._deleteAfter) {
      try {
        fs.unlinkSync(filePath);
      } catch {
        /* ignore */
      }
    }
    return true;
  }

  // 扫描目录下已有文件并投递（启动 / 重扫）
  async _scanSync() {
    if (!this._configured()) return;
    const walk = (dir) => {
      let entries = [];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) {
          if (this._recursive) walk(p);
        } else {
          // 不 await：投递本身是异步归档链路，批量扫描不应阻塞
          this.ingestFile(p).catch(() => {});
        }
      }
    };
    walk(this._path);
  }

  // 新文件可能尚未写完，延迟一点再读并有限重试
  _ingestLater(filePath) {
    const tryRead = (attempt) => {
      const t = setTimeout(() => {
        this._timers.delete(t);
        this.ingestFile(filePath).catch(() => {
          if (attempt < 3) this._ingestLater(filePath);
        });
      }, 300 * attempt);
      this._timers.add(t);
    };
    tryRead(1);
  }
}
