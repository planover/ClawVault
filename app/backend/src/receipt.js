import { isPureEmojiText } from './wechatEmoji.js';

// 归档回执服务：Bot 收到消息后，按"会话对象"汇总收到的消息类型与数量，
// 会话静默（空闲窗口，默认 45s）后向发送者回一条归档回执。回执格式严格如下：
//   YYYY年MM月DD日 共收到 N 条消息
//   文字消息 x 条
//   图片消息 x 条
//   …（数量为 0 的类型不列出；日期取发送时的本地时间）
//
// 设计要点：
//   - **计数口径是"当天累计"**：回执抬头写的是「YYYY年MM月DD日 共收到 N 条消息」，
//     带日期就意味着"这一天总共收到多少条"。因此 N 必须是该会话自本地零点起的累计数，
//     而不是空闲窗口内那一批的数量。v1.0.31 及之前只统计窗口内批次，
//     而人类打字间隔普遍大于当时的 3.5s 去抖窗口，结果每发一条消息就收到一封
//     「共收到 1 条消息」——数字永远对不上。
//   - 计数直接查库（countSince 回调），因此进程重启、跨批次都不会漏算或重复算；
//     未注入 countSince 时（如单元测试）退化为内存计数，行为与旧版一致。
//   - 空闲窗口只决定"多久发一封"：窗口内又来新消息就顺延，会话真正安静下来才发，
//     避免一条消息一封回执的消息风暴。
//   - 仅对支持主动外发的通道生效（channel.send 存在）；filedrop / 演示通道无 send 直接跳过。
//   - 发送失败只记日志、不影响主流程，绝不让回执逻辑把归档链路带崩。
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

// 展示顺序。注意 sticker 与 emoji 共用「表情消息」标签，必须按标签合并后输出，
// 否则同一封回执里会出现两行「表情消息」。
const LABEL_ORDER = ['文字消息', '图片消息', '表情消息', '视频消息', '语音消息', '文件消息', '位置消息'];

// 本地零点的时间戳：回执按"天"累计，跨零点自动从 0 重新起算。
export function startOfLocalDay(now = Date.now()) {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export class ReceiptService {
  // countSince: 可选，(channelId, peer, sinceTs) => { kind: 数量 }，用于取当天累计。
  constructor({ debounceMs = 45000, countSince = null } = {}) {
    this.debounceMs = debounceMs;
    this.countSince = countSince;
    // key: `${channelId}::${peer}` -> { counts, peer, channel, timer, contextToken }
    // counts 仅在未注入 countSince 时使用（内存口径，供单元测试）。
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
      b = { counts: {}, peer, channel, timer: null, contextToken: '' };
      this._buckets.set(key, b);
    }
    b.counts[kind] = (b.counts[kind] || 0) + 1;
    // 记住最近一次的 contextToken：iLink 下带着它发送才能落到正确的会话上下文
    if (msg.contextToken) b.contextToken = msg.contextToken;
    // 空闲窗口去抖：期间的新消息顺延计时，会话静默后才发一封汇总回执
    if (b.timer) clearTimeout(b.timer);
    b.timer = setTimeout(() => this._flush(key), this.debounceMs);
  }

  async _flush(key) {
    const b = this._buckets.get(key);
    if (!b) return;
    this._buckets.delete(key);

    let counts = b.counts;
    if (typeof this.countSince === 'function') {
      try {
        // 当天累计：直接以库为准，重启 / 跨批次都不会算错
        const fromDb = await this.countSince(b.channel.id, b.peer, startOfLocalDay());
        if (fromDb && Object.keys(fromDb).length) counts = fromDb;
      } catch (e) {
        console.error('[回执] 统计当日消息失败（已忽略）:', e?.message || e);
        return;
      }
    }

    // 按标签合并（sticker + emoji → 表情消息）
    const byLabel = {};
    let total = 0;
    for (const [kind, n] of Object.entries(counts || {})) {
      if (!n) continue;
      const label = KIND_LABEL[kind] || `${kind}消息`;
      byLabel[label] = (byLabel[label] || 0) + n;
      total += n;
    }
    if (!total) return;

    // 日期取发送时的本地时间（年四位、月日两位）
    const now = new Date();
    const y = now.getFullYear();
    const mo = String(now.getMonth() + 1).padStart(2, '0');
    const d = String(now.getDate()).padStart(2, '0');
    let text = `${y}年${mo}月${d}日 共收到 ${total} 条消息`;
    // 先按既定顺序输出，再补上未预定义的类型标签，保证不丢行
    const labels = [...LABEL_ORDER, ...Object.keys(byLabel).filter((l) => !LABEL_ORDER.includes(l))];
    for (const label of labels) {
      const n = byLabel[label];
      if (n) text += `\n${label} ${n} 条`;
    }

    try {
      await b.channel.send(b.peer, text, { receipt: true, contextToken: b.contextToken });
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
