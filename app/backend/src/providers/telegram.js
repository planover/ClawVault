// Telegram Bot 适配器
// 协议：Telegram Bot API（BotFather 获取 token）。入站用 getUpdates 长轮询，出站用 sendMessage。
import { Provider } from './base.js';

const API = 'https://api.telegram.org';

// 从 Telegram 消息对象推断平台类型（供"优先用平台类型归类、减少 AI"使用）
function telegramKind(m) {
  if (m.photo) return 'image';
  if (m.video) return 'video';
  if (m.voice) return 'voice';
  if (m.audio) return 'audio';
  if (m.document) return 'file';
  if (m.sticker) return 'sticker';
  if (m.location || m.venue) return 'location';
  if (m.contact) return 'contact';
  if (m.entities?.some((e) => e.type === 'bot_command')) return 'bot_command';
  if (m.text) return 'text';
  return 'text';
}

export class TelegramProvider extends Provider {
  constructor({ channel }) {
    super({ channel });
    this.token = '';
    this._offset = 0;
    this._running = false;
  }

  _configured() {
    return Boolean(this.cfg.bot_token);
  }

  async startLogin() {
    this.token = this.cfg.bot_token || '';
    this.channel.loggedIn = Boolean(this.token);
    this.channel.needRescan = !this.token;
    this.channel._emitStatus();
    if (this.token) this.start();
    return {};
  }

  resume() {
    this.token = this.cfg.bot_token || '';
    this.channel.loggedIn = Boolean(this.token);
    this.channel.needRescan = !this.token;
    if (this.token) this.start();
  }

  start() {
    if (this._running || !this.token) return;
    this._running = true;
    const loop = async () => {
      while (this._running && this.token) {
        try {
          const res = await fetch(
            `${API}/bot${this.token}/getUpdates?offset=${this._offset}&timeout=30`,
            { method: 'GET' },
          );
          const data = await res.json().catch(() => null);
          for (const u of data?.result || []) {
            this._offset = Math.max(this._offset, u.update_id + 1);
            const m = u.message || u.channel_post;
            const text = m?.text || m?.caption;
            if (!text && !m?.voice && !m?.audio) continue;
            const peer = m.chat?.id != null ? String(m.chat.id) : 'telegram';
            const kind = telegramKind(m);
            // 语音留言：通过 getFile 取下载地址，作为 media 透传（保存到聊天.xlsx 并转写）
            let media = null;
            if (kind === 'voice') {
              media = await this._voiceMedia(m);
            }
            await this.channel.deliver({ peer, text, contextToken: '', ts: (u.message?.date || 0) * 1000 || Date.now(), raw: u, kind, media });
          }
        } catch {
          if (!this._running) break;
          await new Promise((r) => setTimeout(r, 3000));
        }
      }
    };
    loop();
  }

  // 通过 getFile 取语音/音频的可下载地址（返回 { url, ext } 或 null）
  async _voiceMedia(m) {
    const f = m.voice || m.audio;
    if (!f?.file_id) return null;
    try {
      const r = await fetch(`${API}/bot${this.token}/getFile?file_id=${f.file_id}`).then((x) => x.json());
      const fp = r?.result?.file_path;
      if (!fp) return null;
      return { url: `${API}/file/bot${this.token}/${fp}`, ext: (fp.split('.').pop() || 'ogg').slice(0, 6) };
    } catch {
      return null;
    }
  }

  async send(peer, text) {
    if (!this.token) throw new Error('未配置 bot_token');
    const res = await fetch(`${API}/bot${this.token}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: peer, text }),
    });
    if (!res.ok) throw new Error(`发送失败 ${res.status}`);
    return res.status;
  }

  stop() {
    this._running = false;
  }

  toJSON() {
    return { token: this.token, offset: this._offset };
  }

  applyState(state = {}) {
    this.token = state.token || this.cfg.bot_token || '';
    this._offset = state.offset || 0;
  }
}
