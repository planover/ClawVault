// 微信 ClawBot（iLink 协议）适配器
// 协议细节来自腾讯官方开放实现（openclaw-weixin / weixin-ClawBot-API）：
// 接入域名 ilinkai.weixin.qq.com，需携带 ilink_bot_token 与 X-WECHAT-UIN。
import QRCode from 'qrcode';
import fs from 'node:fs';
import path from 'node:path';
import config from '../config.js';
import { getQRCode, getQRCodeStatus, getUpdates, sendMessage } from '../ilink/protocol.js';
import { Provider } from './base.js';

const SESSION_MS = 24 * 3600 * 1000;
const RECONNECT_AT = SESSION_MS * 0.92; // 到期前 8% 自动生成新二维码

// 从 iLink 原始消息推断平台消息类型（供"优先用平台类型归类、减少 AI"使用）
export function wechatKind(msg) {
  const item = msg.item_list?.[0];
  if (!item) return 'text';
  if (item.image_item) return 'image';
  if (item.voice_item) return 'voice';
  if (item.video_item) return 'video';
  if (item.file_item || item.file) return 'file';
  if (item.emoji_item) return 'sticker';
  if (item.location_item) return 'location';
  if (item.text_item) return 'text';
  return 'text';
}

import { normalizeAesKey } from '../ilink_crypto.js';

// 提取图片 / 视频 / 文件 / 语音 / 表情的媒体地址，供 Storage 落盘。
// iLink 真机结构（已通过真机 debug 日志确认）：直链藏在
//   <kind>_item.media.full_url，且用 <kind>_item.aeskey（hex）做 AES-128-ECB 加密。
// 这里做尽量宽松的兼容，按优先级尝试多种字段名，并透传解密密钥。
// 返回 { url, ext, aesKey } 或 null（纯文本 / 无可用地址时）。
export function extractMedia(msg, kind) {
  const item = msg.item_list?.[0] || {};
  let m = null;
  if (kind === 'image') m = item.image_item || {};
  else if (kind === 'video') m = item.video_item || {};
  else if (kind === 'file') m = item.file_item || item.file || {};
  else if (kind === 'voice') m = item.voice_item || {};
  else if (kind === 'sticker') m = item.emoji_item || item.sticker_item || {};
  if (!m) return null;
  // 真机直链优先取 media.full_url；其次退化到顶层各类 url 字段
  const url =
    m.media?.full_url ||
    m.full_url ||
    m.image_url ||
    m.cdn_url ||
    m.url ||
    m.file_url ||
    m.video_url ||
    m.voice_url ||
    m.thumb_url ||
    (typeof m === 'string' ? m : null);
  if (!url) return null;
  const aesKey = normalizeAesKey(m.aeskey || m.media?.aes_key);
  const ext = (m.ext || (url.split('?')[0].split('.').pop() || 'bin')).slice(0, 6).replace(/[^\w]/g, '');
  return { url, ext, aesKey };
}

// 诊断：图片/视频/文件/表情消息取不到直链下载地址时，把原始 item 记录到日志，
// 用于在真机拿到 iLink 真实媒体字段结构（image_id/aes_key/cdn…）以补齐字节下载。
const MEDIA_KINDS = ['image', 'video', 'file', 'sticker'];
function diagRawMedia(msg, kind) {
  if (!config?.dataDir) return;
  try {
    const f = path.join(config.dataDir, 'clawvault-media-debug.log');
    const entry = { ts: new Date().toISOString(), kind, from: msg.from_user_id, item: msg.item_list?.[0] };
    fs.appendFileSync(f, JSON.stringify(entry) + '\n');
  } catch {
    /* 诊断日志失败不影响主流程 */
  }
}

export class WeChatIlinkProvider extends Provider {
  constructor({ channel }) {
    super({ channel });
    this.token = null;
    this.baseUrl = '';
    this.loginTime = 0;
    this._buf = '';
    this._statusTimer = null;
    this._running = false;
  }

  async startLogin() {
    const data = await getQRCode();
    this.channel.qrcode = data.qrcode;
    this.channel.qrcodeImg = data.qrcode_img_content || '';
    const payload =
      this.channel.qrcodeImg && this.channel.qrcodeImg.startsWith('http')
        ? this.channel.qrcodeImg
        : this.channel.qrcode || '';
    try {
      this.channel.qrcodeDataUrl = await QRCode.toDataURL(payload);
    } catch {
      this.channel.qrcodeDataUrl = '';
    }
    this.token = null;
    this.channel.loggedIn = false;
    this.channel.needRescan = true;
    this.channel._emitStatus();
    this._pollStatus();
    return {
      qrcode: this.channel.qrcode,
      qrcodeImg: this.channel.qrcodeImg,
      qrcodeDataUrl: this.channel.qrcodeDataUrl,
    };
  }

  _pollStatus() {
    if (this._statusTimer) clearInterval(this._statusTimer);
    this._statusTimer = setInterval(async () => {
      try {
        const st = await getQRCodeStatus(this.channel.qrcode);
        if (st && st.status === 'confirmed') {
          clearInterval(this._statusTimer);
          this._statusTimer = null;
          this.token = st.bot_token;
          this.baseUrl = st.baseurl || '';
          this.loginTime = Date.now();
          this.channel.loggedIn = true;
          this.channel.needRescan = false;
          this.channel._emitStatus();
          this.start();
        }
      } catch {
        /* 网络抖动忽略，下一轮继续 */
      }
    }, 1500);
  }

  resume() {
    if (this.token && this.channel.loggedIn && Date.now() - this.loginTime < SESSION_MS) {
      this.start();
      this.channel._emitStatus();
    } else {
      this.channel.loggedIn = false;
      this.channel.needRescan = true;
      this.startLogin().catch(() => {});
    }
  }

  start() {
    if (this._running) return;
    this._running = true;
    const loop = async () => {
      while (this._running && this.token) {
        if (Date.now() - this.loginTime > RECONNECT_AT && !this.channel.needRescan) {
          this.channel.needRescan = true;
          this.channel._emitStatus();
          this.startLogin().catch(() => {});
        }
        try {
          const res = await getUpdates(this.token, this.baseUrl, this._buf);
          this._buf = res.get_updates_buf || this._buf;
          for (const msg of res.msgs || []) {
            if (msg.message_type !== 1) continue; // 仅处理私聊
            const item = msg.item_list?.[0] || {};
            const kind = wechatKind(msg);
            // 社交端转写：微信语音在 voice_item 中带转写文字时使用
            let text = item.text_item?.text || '';
            if (kind === 'voice') {
              text = item.voice_item?.voice_text || item.voice_item?.text || '';
            }
            // 提取图片/视频/文件/语音媒体地址（用于落盘与前端展示）
            const media = extractMedia(msg, kind);
            // 无法提取直链时记录原始 item，便于后续实现真实下载
            if (MEDIA_KINDS.includes(kind) && !(media && media.url)) {
              diagRawMedia(msg, kind);
            }
            // 纯文本无内容、且既非语音也无可提取媒体时跳过（避免空行）
            // 注意：图片/视频/文件即使没有文本也必须保留，否则消息被静默丢弃
            if (!text && kind !== 'voice' && !media) continue;
            await this.channel.deliver({
              peer: msg.from_user_id,
              text,
              contextToken: msg.context_token,
              ts: Date.now(),
              raw: msg,
              kind,
              media,
            });
          }
        } catch {
          if (!this._running) break;
          await new Promise((r) => setTimeout(r, 3000));
        }
      }
    };
    loop();
  }

  reLogin() {
    this.stop();
    this.startLogin().catch(() => {});
  }

  async send(peer, text, ctx = {}) {
    if (!this.token) throw new Error('未登录');
    return sendMessage(this.token, this.baseUrl, peer, ctx.contextToken || '', text);
  }

  stop() {
    this._running = false;
    if (this._statusTimer) {
      clearInterval(this._statusTimer);
      this._statusTimer = null;
    }
  }

  toJSON() {
    return { token: this.token, baseUrl: this.baseUrl, loginTime: this.loginTime, buf: this._buf };
  }

  applyState(state = {}) {
    this.token = state.token || null;
    this.baseUrl = state.baseUrl || '';
    this.loginTime = state.loginTime || 0;
    this._buf = state.buf || '';
  }
}
