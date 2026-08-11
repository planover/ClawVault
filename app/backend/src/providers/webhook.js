// 通用 Webhook 适配器（万能接入）
// 适用场景：任何能向 HTTP 端点推送消息、并能调用一个发送 API 的 bot / 平台 / 自建脚本。
//   - 入站：外部系统 POST 到 /api/inbound/:channelId，请求体任意，按常见字段归一化。
//   - 出站：可选，配置 send_url 后调用 send() 转发 { peer, text }。
// 这是覆盖"其他 bot"的兜底方案，无需为每种平台写专属代码。
import { Provider } from './base.js';

function pick(obj, keys) {
  for (const k of keys) {
    const v = obj?.[k];
    if (v !== undefined && v !== null && v !== '') return v;
  }
  return undefined;
}

export class WebhookProvider extends Provider {
  _configured() {
    // Webhook 入站始终可用；出战需配置 send_url（可选）
    return true;
  }

  // 归一化任意 JSON 回调体为 { peer, text, kind?, media? }
  handleInbound(body) {
    if (!body || typeof body !== 'object') return null;
    const text = pick(body, ['text', 'message', 'content', 'msg', 'Message', 'text_content']);
    const peer = pick(body, ['peer', 'from', 'user', 'sender', 'username', 'chat_id', 'userId', 'from_user_id']) || 'webhook';
    const ts = body.ts ? Number(body.ts) : Date.now();
    // 语音支持：显式 voice_url / audio(base64) / kind=voice
    const voiceUrl = body.voice_url || body.audio_url || (body.voice && typeof body.voice === 'string' ? body.voice : '');
    const audioB64 = typeof body.audio === 'string' ? body.audio : '';
    // 允许调用方显式带类型（kind/type），否则按是否有附件猜测
    let kind = body.kind || body.type;
    let media = null;
    if (!kind) {
      if (body.image || body.photo) kind = 'image';
      else if (body.file || body.document || body.attachment) kind = 'file';
      else if (voiceUrl || audioB64 || body.voice || body.audio) kind = 'voice';
      else if (body.video) kind = 'video';
      else kind = 'text';
    }
    if (kind === 'voice') {
      if (voiceUrl) media = { url: String(voiceUrl), ext: (String(voiceUrl).split('.').pop() || 'mp3').slice(0, 6) };
      else if (audioB64) {
        try {
          media = { buffer: Buffer.from(audioB64, 'base64'), ext: (body.audio_ext || 'mp3').slice(0, 6) };
        } catch {
          media = null;
        }
      }
    }
    // 纯文本必须有内容；语音允许无文字（靠转写）
    if (!text && kind === 'text') return null;
    return { peer: String(peer), text: String(text || ''), ts, raw: body, kind: String(kind), media };
  }

  async send(peer, text) {
    const url = this.cfg.send_url;
    if (!url) throw new Error('未配置 send_url，无法外发');
    const headers = { 'content-type': 'application/json' };
    if (this.cfg.send_token) headers['authorization'] = `Bearer ${this.cfg.send_token}`;
    const res = await fetch(url, {
      method: (this.cfg.send_method || 'POST').toUpperCase(),
      headers,
      body: JSON.stringify({ peer, text }),
    });
    if (!res.ok) throw new Error(`外发失败 ${res.status}`);
    return res.status;
  }
}
