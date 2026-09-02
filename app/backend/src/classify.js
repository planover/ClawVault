import config from './config.js';

// 运行时 AI 失败环形缓冲：供 /api/health 暴露最近失败，便于快速定位分类异常根因。
const _recentAiFailures = [];
const MAX_AI_FAILURES = 50;

export function recordAiFailure(info) {
  _recentAiFailures.push({ ts: Date.now(), ...info });
  if (_recentAiFailures.length > MAX_AI_FAILURES) _recentAiFailures.shift();
}

export function getRecentAiFailures() {
  return _recentAiFailures.map((x) => ({ ...x }));
}

// 社交平台能直接判定的消息类型 → 分类（无需 AI）。
// 文本(text)返回 null，表示仍需 AI 做语义归类；其余按类型直接归类，减少 AI 调用。
const KIND_MAP = {
  text: null,
  plain: null,
  image: { category: '图片', sub: '' },
  photo: { category: '图片', sub: '' },
  picture: { category: '图片', sub: '' },
  voice: { category: '语音', sub: '' },
  audio: { category: '语音', sub: '' },
  video: { category: '视频', sub: '' },
  short_video: { category: '视频', sub: '' },
  file: { category: '文件', sub: '' },
  document: { category: '文件', sub: '' },
  sticker: { category: '表情', sub: '' },
  emoji: { category: '表情', sub: '' },
  gif: { category: '表情', sub: '' },
  location: { category: '位置', sub: '' },
  card: { category: '名片', sub: '' },
  contact: { category: '名片', sub: '' },
  link: { category: '链接', sub: '' },
  url: { category: '链接', sub: '' },
  bot_command: { category: '指令', sub: '' },
  command: { category: '指令', sub: '' },
  system: { category: '系统', sub: '' },
  notification: { category: '系统', sub: '' },
};

// 返回平台类型对应的分类；文本或无类型返回 null（交给 AI）
export function platformKindToCategory(kind) {
  if (!kind) return null;
  const k = String(kind).toLowerCase().replace(/[_\s-]/g, '_');
  return KIND_MAP[k] || null;
}

// 纯文本消息的大类。与图片/语音/视频/文件等平台类型并列，
// 用户约定：文本消息默认就落到这里，而不是落到「未分类」。
export const TEXT_CATEGORY = '文本消息';

// 文本消息的最终归类（纯函数，便于测试）：
//   - 未配置 AI，或 AI 判定失败（classifyText 会返回 未分类 哨兵）→ 停在「文本消息」本身，sub 留空；
//   - 配置了 AI → 恒归入「文本消息」大类，把 AI 判定的主分类（及可选子分类）压到 sub，
//     形成 文本消息 > 工作/项目A 这样的层级，避免 AI 分类与平台类型混在同一层。
//   - 纯表情文本：入库时 storage.saveMessage 已把它规整为 emoji 类型，这里同步归入「表情」，
//     与分类统计、回执文案（「表情消息」）保持一致。
export function textClassification(ai, { emoji = false } = {}) {
  if (emoji) return { category: '表情', sub: '', source: 'rule' };
  if (!ai || ai.category === '未分类') return { category: TEXT_CATEGORY, sub: '', source: 'rule' };
  const parts = [ai.category, ai.sub].filter(Boolean);
  return { category: TEXT_CATEGORY, sub: parts.join('/'), source: ai.source || 'ai' };
}

// 分类决策（纯函数，便于测试）：
//   - 开启「优先平台类型」且平台能判定类型 → 直接采用，source='platform'（不调 AI）
//   - 纯文本 / 平台无类型 / 关闭开关 → source='ai'，由调用方再走 classifyText
export function resolveClassification(kind) {
  if (config.classification.usePlatformType !== false) {
    const c = platformKindToCategory(kind);
    if (c) return { ...c, source: 'platform' };
  }
  return { source: 'ai' };
}

// 调用兼容 Anthropic 格式的 /v1/messages 接口，对消息做分类
// 返回 { category, sub } 或 null（未配置 AI 时）
export async function classifyText(text) {
  const { apiKey, baseUrl, model, enabled } = config.ai;
  if (!enabled || !apiKey) return null;

  const url = `${baseUrl.replace(/\/$/, '')}/v1/messages`;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), config.ai.timeout_ms || 15000);
    const res = await fetch(url, {
      method: 'POST',
      signal: ctrl.signal,
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model,
        max_tokens: 300,
        system: config.classification.system_prompt,
        messages: [{ role: 'user', content: text.slice(0, 4000) }],
      }),
    }).finally(() => clearTimeout(timer));
    if (!res.ok) {
      recordAiFailure({ stage: 'classifyText', status: res.status });
      console.error(`[ClawVault] AI 分类接口返回异常状态 ${res.status}`);
      return { category: '未分类', sub: '' };
    }
    const data = await res.json();
    const content = data?.content?.[0]?.text || '';
    return parseCategory(content);
  } catch (e) {
    recordAiFailure({ stage: 'classifyText', error: String(e?.message || e) });
    console.error('[ClawVault] AI 分类失败:', e?.message || e);
    return { category: '未分类', sub: '' };
  }
}

function parseCategory(text) {
  try {
    const m = text.match(/\{[\s\S]*\}/);
    if (m) {
      const o = JSON.parse(m[0]);
      const category = String(o.category || '').trim();
      const sub = o.sub ? String(o.sub).trim() : '';
      if (category) return { category, sub };
    }
  } catch {
    /* 解析失败走默认 */
  }
  return { category: '未分类', sub: '' };
}

// 测试 AI 连接：用给定配置真实地发一次请求，返回是否可用 + 样例分类结果
export async function testConnection({ apiKey, baseUrl, model }) {
  if (!apiKey) return { ok: false, error: '未填写 API Key' };
  const url = `${String(baseUrl || '').replace(/\/$/, '') || 'https://api.anthropic.com'}/v1/messages`;
  const sample = '提醒我明天上午十点跟客户开会，记得带合同。';
  const t0 = Date.now();
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), config.ai.timeout_ms || 15000);
    const res = await fetch(url, {
      method: 'POST',
      signal: ctrl.signal,
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model,
        max_tokens: 300,
        system: '你是一个对话归档分类器。用户会给你一段消息，请判断它应归入哪个分类。只输出 JSON，如 {"category":"工作","sub":"会议"}。',
        messages: [{ role: 'user', content: sample }],
      }),
    }).finally(() => clearTimeout(timer));
    const latencyMs = Date.now() - t0;
    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      return { ok: false, status: res.status, error: `接口返回 ${res.status}：${txt.slice(0, 300)}` };
    }
    const data = await res.json().catch(() => null);
    const content = data?.content?.[0]?.text || '';
    return { ok: true, model, latencyMs, sample: parseCategory(content), raw: content.slice(0, 500) };
  } catch (e) {
    return { ok: false, error: `请求失败：${e.message || e}` };
  }
}
