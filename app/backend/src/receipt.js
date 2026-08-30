import { isPureEmojiText } from './wechatEmoji.js';

// 归档回执服务：Bot 收到消息后，按"会话对象"累计收到的消息类型与数量，
// 去抖（默认 3.5s）后向发送者回一条归档回执。回执格式严格如下：
//   YYYY年MM月DD日 共收到 N 条消息
//   文字消息 x 条
//   图片消息 x 条
//   …（数量为 0 的类型不列出；日期取接收时的本地时间）
//
// 设计要点：
//   - 聚合计数而非每条一封，避免消息风暴；去抖窗口内同会话的多条消息合并为一封回执。
//   - 仅对支持主动外发的通道生效（channel.send 存在）；filedrop / 演示通道无 send 直接跳过。
//   - 发送失败只记日志、不影响主流程，绝不让回执逻辑把归档链路带崩。
const KIND_ORDER = ['text', 'image', 'sticker', 'emoji', 'video', 'voice', 'file', 'location'];
const KIND_LABEL = {
  text: '文字消息',
  image: '图片消息',
  sticker: '表情消息',
  emoji: '表情消息',
  video: '视频消息',
  voice: '语音消息',
  file: '文件消息',
  location: '位置消息',
};

export class ReceiptService {
  constructor({ debounceMs = 3500 } = {}) {
    this.debounceMs = debounceMs;
    // key: `${channelId}::${peer}` -> { counts, peer, channel, timer }
    this._buckets = new Map();
  }

  // 每条入站消息调用一次。enabled 由调用方（按 config.ingest.auto_reply_receipt）传入。
  handle(channel, msg, enabled) {
    if (!enabled) return;
    if (typeof channel?.send !== 'function') return; // 该通道不支持主动外发
    const peer = msg.peer;
    if (!peer) return;

    let kind = msg.kind || 'text';
    // 纯表情文本在入库时会被归为 emoji 类型，这里让回执也归入「表情消息」保持一致
    if (kind === 'text' && msg.text && isPureEmojiText(msg.text)) kind = 'emoji';

    const key = `${channel.id}::${peer}`;
    let b = this._buckets.get(key);
    if (!b) {
      b = { counts: {}, peer, channel, timer: null };
      this._buckets.set(key, b);
    }
    b.counts[kind] = (b.counts[kind] || 0) + 1;
    if (b.timer) clearTimeout(b.timer);
    b.timer = setTimeout(() => this._flush(key), this.debounceMs);
  }

  async _flush(key) {
    const b = this._buckets.get(key);
    if (!b) return;
    this._buckets.delete(key);
    const counts = b.counts;
    const total = Object.values(counts).reduce((a, c) => a + c, 0);
    if (!total) return;

    // 日期取接收时的本地时间（年四位、月日两位）
    const now = new Date();
    const y = now.getFullYear();
    const mo = String(now.getMonth() + 1).padStart(2, '0');
    const d = String(now.getDate()).padStart(2, '0');
    let text = `${y}年${mo}月${d}日 共收到 ${total} 条消息`;
    for (const k of KIND_ORDER) {
      const n = counts[k];
      if (n) text += `\n${KIND_LABEL[k] || `${k}消息`} ${n} 条`;
    }

    try {
      await b.channel.send(b.peer, text, { receipt: true });
    } catch (e) {
      console.error('[回执] 发送失败（已忽略）:', e?.message || e);
    }
  }

  // 进程退出前清空去抖定时器，避免悬挂
  dispose() {
    for (const b of this._buckets.values()) if (b.timer) clearTimeout(b.timer);
    this._buckets.clear();
  }
}
