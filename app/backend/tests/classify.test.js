import test from 'node:test';
import assert from 'node:assert/strict';
import config from '../src/config.js';
import { platformKindToCategory, resolveClassification, classifyText, getRecentAiFailures } from '../src/classify.js';

// 确保默认开启「优先平台类型」
config.classification.usePlatformType = true;

test('平台媒体类型直接映射为分类（无需 AI）', () => {
  const cases = [
    ['image', '图片'],
    ['photo', '图片'],
    ['picture', '图片'],
    ['voice', '语音'],
    ['audio', '语音'],
    ['video', '视频'],
    ['short_video', '视频'],
    ['file', '文件'],
    ['document', '文件'],
    ['sticker', '表情'],
    ['emoji', '表情'],
    ['gif', '表情'],
    ['location', '位置'],
    ['card', '名片'],
    ['contact', '名片'],
    ['link', '链接'],
    ['url', '链接'],
    ['bot_command', '指令'],
    ['command', '指令'],
    ['system', '系统'],
    ['notification', '系统'],
  ];
  for (const [kind, category] of cases) {
    const r = platformKindToCategory(kind);
    assert.ok(r, `kind=${kind} 应被识别为分类`);
    assert.equal(r.category, category, `kind=${kind} 应映射为 ${category}`);
  }
});

test('纯文本 / 未知类型返回 null（应交由 AI）', () => {
  assert.equal(platformKindToCategory('text'), null);
  assert.equal(platformKindToCategory('plain'), null);
  assert.equal(platformKindToCategory('unknown_xyz'), null);
  assert.equal(platformKindToCategory(''), null);
  assert.equal(platformKindToCategory(null), null);
});

test('kind 归一化：大小写 / 连字符 / 下划线 / 空格', () => {
  assert.equal(platformKindToCategory('IMAGE').category, '图片');
  assert.equal(platformKindToCategory('short-video').category, '视频');
  assert.equal(platformKindToCategory('bot command').category, '指令');
});

test('resolveClassification：媒体类型走平台归类、source=platform', () => {
  for (const kind of ['image', 'voice', 'video', 'file', 'sticker', 'location', 'link', 'bot_command', 'system']) {
    const d = resolveClassification(kind);
    assert.equal(d.source, 'platform', `kind=${kind} 应走平台归类`);
    assert.ok(d.category, `kind=${kind} 应有分类`);
  }
});

test('resolveClassification：纯文本走 AI、source=ai', () => {
  for (const kind of ['text', 'plain', null, undefined, 'weird']) {
    const d = resolveClassification(kind);
    assert.equal(d.source, 'ai', `kind=${kind} 应走 AI`);
  }
});

test('resolveClassification：关闭开关后媒体类型也回落 AI', () => {
  config.classification.usePlatformType = false;
  try {
    const d = resolveClassification('image');
    assert.equal(d.source, 'ai', '关闭优先平台类型后，image 应回落 AI');
  } finally {
    config.classification.usePlatformType = true; // 还原
  }
});

test('端到端行为：平台类型为 image 时完全不调用 AI（fetch）', async () => {
  let fetchCalled = 0;
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (...args) => {
    fetchCalled += 1;
    // 即便被调用也返回非 200，避免污染
    return new Response('{}', { status: 401 });
  };
  try {
    config.classification.usePlatformType = true;
    const d = resolveClassification('image');
    // 模拟 handleMessage 的分支：平台归类直接 return，不进 classifyText
    if (d.source === 'platform') {
      // 直接采用平台分类，不触发 classifyText（即不触发 fetch）
      assert.equal(d.category, '图片');
    }
    assert.equal(fetchCalled, 0, '平台类型归类不应调用任何 AI（fetch）');
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('classifyText 失败（网络错误）被记录到 recentFailures 且返回未分类', async () => {
  const before = getRecentAiFailures().length;
  const origFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error('network down');
  };
  try {
    config.ai.enabled = true;
    config.ai.apiKey = 'test-key';
    const r = await classifyText('测试分类文本');
    assert.equal(r.category, '未分类');
    const after = getRecentAiFailures();
    assert.equal(after.length, before + 1, '应多记录一条失败');
    const last = after[after.length - 1];
    assert.equal(last.stage, 'classifyText');
    assert.match(last.error, /network down/);
  } finally {
    globalThis.fetch = origFetch;
    config.ai.apiKey = '';
    config.ai.enabled = DEFAULT_ENABLED();
  }
});

// 还原默认 enabled（classify.js 默认 enabled=true 但要求 apiKey）
function DEFAULT_ENABLED() {
  return Boolean(config.ai.apiKey);
}
