// 微信表情占位符识别
//
// 微信 / 企业微信把表情用方括号占位符表示，例如 [裂开]、[旺柴]、[OK]。
// 一条消息若「整体」仅由这类占位符组成（可多个并列，如 [裂开][旺柴]），
// 应归类为「表情」类型（kind='emoji'）而非普通文本，并在分类 / 统计 / 样式上归入表情。
//
// 注意：
// - 本文件只负责「识别」，渲染所需的 code→unicode 映射放在前端 wechatEmoji.js，
//   避免后端依赖一份庞大的表情表；分类只需知道「整条是否为表情」即可。
// - 占位符判定不要求命中已知表情表，未知表情同样算作表情类型（前端会兜底渲染）。

// 单个占位符： [任意非 ] 非换行的字符]
const EMOJI_TOKEN = /\[[^\]\n]+\]/;
// 整条消息：去掉首尾空白后，必须「全由占位符组成」
const PURE_EMOJI_RE = /^\[[^\]\n]+\](?:\[[^\]\n]+\])*$/;

// 判断一段文本是否「整体为表情」（用于把 text 类消息归类为 emoji）
export function isPureEmojiText(text) {
  if (!text) return false;
  const t = String(text).trim();
  if (!t) return false;
  return PURE_EMOJI_RE.test(t);
}

// 文本中是否包含至少一个表情占位符（用于渲染层判断）
export function hasEmojiToken(text) {
  return EMOJI_TOKEN.test(String(text || ''));
}

// 提取文本中的所有表情 code（去重、保序），便于渲染层逐个映射
export function extractEmojiCodes(text) {
  const out = [];
  const re = /\[([^\]\n]+)\]/g;
  let m;
  while ((m = re.exec(String(text || ''))) !== null) {
    const code = m[1].trim();
    if (code && !out.includes(code)) out.push(code);
  }
  return out;
}
