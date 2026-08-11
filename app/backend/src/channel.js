// 泛型通道：按 providerType 实例化对应 Provider 并委托其协议细节。
// 所有 bot（微信 ClawBot / Telegram / Webhook / 办公 IM / Discord）在此统一为"通道"。
import { randomUUID } from 'node:crypto';
import { getProvider } from './providers/index.js';

export class Channel {
  constructor({ id, name, providerType, providerConfig, onMessage, onStatus, store }) {
    this.id = id || randomUUID();
    this.name = name || '通道';
    this.providerType = providerType || 'wechat_ilink';
    this.providerConfig = providerConfig || {};
    this.onMessage = onMessage;
    this.onStatus = onStatus;
    this.store = store;

    // 前端展示用的通用字段
    this.loggedIn = false;
    this.needRescan = false;
    this.qrcode = null;
    this.qrcodeImg = null;
    this.qrcodeDataUrl = null;
    this.extra = {};

    this.provider = getProvider(this.providerType, { channel: this });
  }

  async startLogin() {
    const info = await this.provider.startLogin?.();
    this._emitStatus();
    return info || {};
  }

  resume() {
    this.provider.resume?.();
    this._emitStatus();
  }

  start() {
    this.provider.start?.();
  }

  stop() {
    this.provider.stop?.();
  }

  async send(peer, text, ctx) {
    return this.provider.send?.(peer, text, ctx);
  }

  // Webhook 类入站：归一化平台回调；返回 { peer, text, ts, raw } | { verify } | null
  handleInbound(body, headers) {
    return this.provider.handleInbound?.(body, headers);
  }

  // Provider 收到消息后调用，进入归档/分类链路（kind = 平台判定的消息类型；media = 语音音频等二进制）
  async deliver({ peer, text, contextToken, ts, raw, kind, media }) {
    return this.onMessage?.(this, { peer, text, contextToken, ts, raw, kind, media });
  }

  _emitStatus() {
    this.onStatus?.(this);
  }

  toJSON() {
    return {
      id: this.id,
      name: this.name,
      providerType: this.providerType,
      providerConfig: this.providerConfig,
      loggedIn: this.loggedIn,
      needRescan: this.needRescan,
      qrcode: this.qrcode,
      qrcodeImg: this.qrcodeImg,
      qrcodeDataUrl: this.qrcodeDataUrl,
      extra: this.provider.toJSON?.() || {},
    };
  }

  applyState(s = {}) {
    this.name = s.name || this.name;
    this.providerType = s.providerType || this.providerType;
    this.providerConfig = s.providerConfig || {};
    this.loggedIn = s.loggedIn || false;
    this.needRescan = s.needRescan || false;
    this.qrcode = s.qrcode || null;
    this.qrcodeImg = s.qrcodeImg || null;
    this.qrcodeDataUrl = s.qrcodeDataUrl || null;
    this.extra = s.extra || {};
    // providerType 可能变化，重建 provider 实例并灌入状态
    this.provider = getProvider(this.providerType, { channel: this });
    this.provider.applyState?.(this.extra);
  }
}
