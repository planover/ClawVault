// 多通道管理器（泛型）：负责通道的增删、持久化、状态恢复与入站投递。
// 不再绑定微信，通道类型由 providerType 决定（见 src/providers）。
import fs from 'node:fs';
import path from 'node:path';
import * as vault from './vault.js';
import { Channel } from './channel.js';
import { PROVIDERS } from './providers/index.js';

export class ChannelManager {
  constructor({ dataDir, onMessage, onStatus }) {
    this.dataDir = dataDir;
    this.onMessage = onMessage;
    this.onStatus = onStatus;
    this.storePath = path.join(dataDir, 'channels.json');
    this._key = vault.loadKey(dataDir); // 主密钥：CLV_MASTER_KEY > data_dir/.clvkey
    this.channels = new Map();
    this.credentialError = false; // 解密失败（密钥丢失/文件损坏）时置位，供前端提示重新绑定
    this._load();
  }

  _load() {
    let list = [];
    try {
      const raw = fs.readFileSync(this.storePath, 'utf8');
      let parsed = null;
      try {
        parsed = JSON.parse(raw); // 旧明文：兼容迁移
      } catch {
        parsed = null;
      }
      if (parsed) {
        list = parsed;
        this._persist(); // 首次读取为明文 → 立即重写为加密态
      } else {
        try {
          list = vault.decryptJSON(raw, this._key); // 加密态
        } catch (de) {
          // 密钥丢失或文件损坏（如卸载重装清掉了 data-share 后残留旧文件）：
          // 不能让启动直接崩溃，降级为"空通道 + 明确报错"，由前端引导用户重新绑定。
          console.error(
            '[ClawVault] 凭据解密失败（密钥丢失或文件损坏），以空通道列表启动：',
            de?.message || de,
          );
          this.credentialError = true;
          list = [];
        }
      }
    } catch (e) {
      if (e && e.code === 'ENOENT') list = [];
      else throw e; // 加密文件损坏 / 密钥错误 → 显式报错
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
    fs.mkdirSync(this.dataDir, { recursive: true });
    fs.writeFileSync(this.storePath, vault.encryptJSON(list, this._key), { mode: 0o600 });
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

  // 重命名通道（仅改显示名；归档文件夹与 DB 由 storage.renameChannel 负责）
  renameChannel(id, name) {
    const ch = this.channels.get(id);
    if (!ch) throw new Error('通道不存在');
    ch.name = name;
    this._persist();
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
