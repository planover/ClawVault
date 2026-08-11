// 办公 IM 适配器：钉钉 / 飞书 / 企业微信
// 这三种国内办公机器人形态高度相似——入站是平台回调（Webhook），出站是群机器人 Webhook。
// 这里统一实现：入站把各平台回调体归一化；出站按平台拼装群机器人 Webhook 报文（支持签名）。
// 说明：入站默认不做严格签名校验（部署时建议在网络层或反向代理处校验来源）；
//       如需严格校验请按各平台文档补充 verify_secret 逻辑。
import crypto from 'node:crypto';
import { Provider } from './base.js';

function sign(timestamp, secret) {
  return crypto.createHmac('sha256', secret).update(`${timestamp}\n${secret}`).digest('base64');
}

export class OfficeProvider extends Provider {
  get platform() {
    return (this.cfg.platform || 'feishu').toLowerCase();
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

  handleInbound(body) {
    if (!body || typeof body !== 'object') return null;
    let text = undefined;
    let peer = undefined;
    let kind = 'text';
    const p = this.platform;
    try {
      if (p === 'dingtalk') {
        text = body?.text?.content || body?.text || body?.content;
        peer = body?.senderId || body?.senderNick || body?.conversationId || 'dingtalk';
        const mt = body?.msgtype || body?.messageType;
        if (mt && mt !== 'text') kind = mt;
      } else if (p === 'feishu') {
        const content = body?.event?.message?.content || body?.content;
        if (typeof content === 'string') text = JSON.parse(content)?.text;
        else text = content?.text;
        peer =
          body?.event?.sender?.sender_id?.open_id ||
          body?.event?.message?.chat_id ||
          body?.sender?.sender_id?.open_id ||
          'feishu';
        const mt = body?.event?.message?.message_type || body?.header?.event_type;
        if (mt && mt !== 'text') kind = mt;
      } else {
        // wecom：自建应用回调 或 群机器人回调
        text = body?.text?.content || body?.Content || body?.text;
        peer = body?.from?.alias || body?.FromUserName || body?.from?.name || 'wecom';
        const mt = body?.MsgType || body?.msgtype;
        if (mt && mt !== 'text') kind = mt;
      }
    } catch {
      /* 解析失败返回 null */
    }
    if (!text) return null;
    return { peer: String(peer), text: String(text), ts: Date.now(), raw: body, kind: String(kind) };
  }

  async send(/* peer, text */) {
    const url = this.cfg.outgoing_url || this.cfg.webhook_url;
    if (!url) throw new Error('未配置 outgoing_url，无法外发');
    const text = arguments[1];
    const p = this.platform;
    let finalUrl = url;
    let payload;
    if (p === 'feishu') {
      const ts = Date.now();
      const s = this.cfg.secret ? sign(ts, this.cfg.secret) : '';
      payload = { msg_type: 'text', content: JSON.stringify({ text }) };
      if (this.cfg.secret) {
        payload.timestamp = String(ts);
        payload.sign = s;
      }
    } else if (p === 'wecom') {
      payload = { msgtype: 'text', text: { content: text } };
    } else {
      // dingtalk
      const ts = Date.now();
      const s = this.cfg.secret ? sign(ts, this.cfg.secret) : '';
      payload = { msgtype: 'text', text: { content: text } };
      if (this.cfg.secret) finalUrl = `${url}&timestamp=${ts}&sign=${encodeURIComponent(s)}`;
    }
    const res = await fetch(finalUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) throw new Error(`外发失败 ${res.status}`);
    return res.status;
  }
}
