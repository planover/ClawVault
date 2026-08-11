// 多通道管理器（泛型）：负责通道的增删、持久化、状态恢复与入站投递。
// 不再绑定微信，通道类型由 providerType 决定（见 src/providers）。
import fs from 'node:fs';
import path from 'node:path';
import { Channel } from './channel.js';
import { PROVIDERS } from './providers/index.js';

export class ChannelManager {
  constructor({ dataDir, onMessage, onStatus }) {
    this.dataDir = dataDir;
    this.onMessage = onMessage;
    this.onStatus = onStatus;
    this.storePath = path.join(dataDir, 'channels.json');
    this.channels = new Map();
    this._load();
  }

  _load() {
    let list = [];
    try {
      list = JSON.parse(fs.readFileSync(this.storePath, 'utf8'));
    } catch {
      list = [];
    }
    for (const s of list) {
      const ch = new Channel({
        id: s.id,
        name: s.name,
        providerType: s.providerType,
        providerConfig: s.providerConfig,
        onMessage: this.onMessage,
        onStatus: this.onStatus,
        store: this,
      });
      ch.applyState(s);
      this.channels.set(ch.id, ch);
    }
  }

  _persist() {
    const list = [...this.channels.values()].map((ch) => ch.toJSON());
    fs.writeFileSync(this.storePath, JSON.stringify(list, null, 2));
  }

  // 供 Channel.save() 调用
  saveChannel() {
    this._persist();
  }

  // 进程重启后恢复各通道连接（manager 就绪后调用）
  resumeAll() {
    for (const ch of this.channels.values()) ch.resume();
  }

  createChannel({ name, providerType, providerConfig } = {}) {
    const ch = new Channel({
      name: name || `通道${this.channels.size + 1}`,
      providerType,
      providerConfig,
      onMessage: this.onMessage,
      onStatus: this.onStatus,
      store: this,
    });
    this.channels.set(ch.id, ch);
    this._persist();
    return ch;
  }

  getChannel(id) {
    return this.channels.get(id);
  }

  // 列表脱敏：不含 token / secret
  listChannels() {
    return [...this.channels.values()].map((ch) => {
      const meta = PROVIDERS[ch.providerType] || {};
      const cfg = { ...ch.providerConfig };
      // 脱敏密钥类字段
      for (const f of meta.configFields || []) {
        if (f.type === 'password' && cfg[f.key]) cfg[f.key] = '••••••••';
      }
      return {
        id: ch.id,
        name: ch.name,
        providerType: ch.providerType,
        providerName: meta.name || ch.providerType,
        providerIcon: meta.icon || '🤖',
        auth: meta.auth || 'webhook',
        connected: ch.loggedIn,
        needRescan: ch.needRescan,
        qrcode: ch.qrcode,
        qrcodeImg: ch.qrcodeImg,
        qrcodeDataUrl: ch.qrcodeDataUrl,
        config: cfg,
      };
    });
  }

  removeChannel(id) {
    const ch = this.channels.get(id);
    if (ch) ch.stop();
    this.channels.delete(id);
    this._persist();
  }

  async startLogin(id) {
    const ch = this.channels.get(id);
    if (!ch) throw new Error('通道不存在');
    return ch.startLogin();
  }

  reLogin(id) {
    const ch = this.channels.get(id);
    if (!ch) throw new Error('通道不存在');
    ch.stop();
    ch.startLogin().catch(() => {});
  }

  // Webhook 类入站：归一化后进入归档链路。返回 { verify } 时由路由直接回显（Slack 订阅验证）。
  async inbound(id, body, headers) {
    const ch = this.channels.get(id);
    if (!ch) throw new Error('通道不存在');
    const norm = ch.handleInbound(body, headers);
    if (!norm) return { ok: false, reason: 'ignored' };
    if (norm.verify) return { verify: norm.verify };
    await ch.deliver(norm);
    return { ok: true };
  }
}
