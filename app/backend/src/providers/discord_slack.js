// Discord / Slack 适配器
// 这类海外协作工具的 bot 通常需要网关/事件订阅，自托管场景下最常见的轻量做法是：
//   - 入站：用平台「Webhook / Events」把消息推到 /api/inbound/:channelId，这里做归一化。
//   - 出站：用平台「Incoming Webhook URL」直接 POST 报文。
// 因此复用通用 Webhook 思路，仅补充两家平台的报文格式差异。
import { Provider } from './base.js';

export class DiscordSlackProvider extends Provider {
  get platform() {
    return (this.cfg.platform || 'slack').toLowerCase();
  }

  _configured() {
    return Boolean(this.cfg.outgoing_url || this.cfg.webhook_url);
  }

  async startLogin() {
    this.channel.loggedIn = this._configured();
    this.channel.needRescan = !this._configured();
    this.channel._emitStatus();
    return {};
  }

  resume() {
    this.channel.loggedIn = this._configured();
    this.channel.needRescan = !this._configured();
  }

  // 返回特殊标记对象 { verify: challenge } 时，路由需直接回显 challenge（Slack 订阅验证）
  handleInbound(body) {
    if (!body || typeof body !== 'object') return null;
    if (body.type === 'url_verification') return { verify: body.challenge };
    let text = undefined;
    let peer = undefined;
    let kind = 'text';
    let media = null;
    const p = this.platform;
    const atts = body?.event?.files || body?.files || body?.attachments || body?.event?.attachments || [];
    const audioAtt = atts.find(
      (a) => (a.mimetype || a.content_type || '').startsWith('audio') || /\.(mp3|wav|m4a|ogg|oga|flac)$/i.test(a.url || a.filename || a.name || ''),
    );
    if (audioAtt) {
      kind = 'voice'; // 音频附件 → 语音，进 聊天.xlsx
      const url = audioAtt.url_private || audioAtt.url || audioAtt.proxy_url;
      if (url) media = { url, ext: (String(audioAtt.url || audioAtt.filename || '').split('.').pop() || 'ogg').slice(0, 6) };
    } else if (atts.length) {
      kind = 'file';
    }
    if (p === 'slack') {
      if (body.event?.bot_id) return null; // 忽略 bot 自己的消息，避免回环
      text = body.event?.text || body.text;
      peer = body.event?.user || body.user || body.event?.channel || 'slack';
    } else {
      // discord
      if (body?.author?.bot || body?.bot) return null;
      text = body.content || body.text;
      peer = body.author?.username || body.username || body.user || 'discord';
    }
    if (!text && kind === 'text') return null;
    return { peer: String(peer), text: String(text || ''), ts: Date.now(), raw: body, kind, media };
  }

  async send(/* peer, text */) {
    const url = this.cfg.outgoing_url || this.cfg.webhook_url;
    if (!url) throw new Error('未配置 outgoing_url，无法外发');
    const text = arguments[1];
    const payload = this.platform === 'slack' ? { text } : { content: text };
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) throw new Error(`外发失败 ${res.status}`);
    return res.status;
  }
}
