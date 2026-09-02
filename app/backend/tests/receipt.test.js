import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ReceiptService } from '../src/receipt.js';

// 回执格式：
//   YYYY年MM月DD日 共收到 N 条消息
//   文字消息 x 条
//   …（数量为 0 的类型不显示）
const pad = (n) => String(n).padStart(2, '0');
function expectedHeader() {
  const d = new Date();
  return `${d.getFullYear()}年${pad(d.getMonth() + 1)}月${pad(d.getDate())}日`;
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function fakeChannel() {
  const sent = [];
  return {
    id: 'c1',
    send: async (peer, text) => sent.push({ peer, text }),
    sent,
  };
}

test('回执：合并同会话多条消息，按类型统计且格式正确', async () => {
  const svc = new ReceiptService({ debounceMs: 20 });
  const ch = fakeChannel();
  svc.handle(ch, { peer: 'u1', kind: 'text' }, true);
  svc.handle(ch, { peer: 'u1', kind: 'text' }, true);
  svc.handle(ch, { peer: 'u1', kind: 'image' }, true);
  await wait(80);
  assert.equal(ch.sent.length, 1, '去抖窗口内的消息应合并为一封回执');
  assert.equal(ch.sent[0].peer, 'u1');
  assert.equal(ch.sent[0].text, `${expectedHeader()} 共收到 3 条消息\n文字消息 2 条\n图片消息 1 条`);
  svc.dispose();
});

test('回执：数量为 0 的类型不显示，且只统计本次收到的条目', async () => {
  const svc = new ReceiptService({ debounceMs: 20 });
  const ch = fakeChannel();
  svc.handle(ch, { peer: 'u2', kind: 'file' }, true);
  await wait(80);
  // 只有文件消息一行，不应出现「文字消息 0 条」之类
  assert.equal(ch.sent[0].text, `${expectedHeader()} 共收到 1 条消息\n文件消息 1 条`);
  assert.ok(!/0 条/.test(ch.sent[0].text));
  svc.dispose();
});

test('回执：不同会话分别统计', async () => {
  const svc = new ReceiptService({ debounceMs: 20 });
  const ch = fakeChannel();
  svc.handle(ch, { peer: 'a', kind: 'text' }, true);
  svc.handle(ch, { peer: 'b', kind: 'voice' }, true);
  svc.handle(ch, { peer: 'b', kind: 'voice' }, true);
  await wait(80);
  assert.equal(ch.sent.length, 2);
  const byPeer = Object.fromEntries(ch.sent.map((s) => [s.peer, s.text]));
  assert.equal(byPeer.a, `${expectedHeader()} 共收到 1 条消息\n文字消息 1 条`);
  assert.equal(byPeer.b, `${expectedHeader()} 共收到 2 条消息\n语音消息 2 条`);
  svc.dispose();
});

test('回执：未启用时不发送', async () => {
  const svc = new ReceiptService({ debounceMs: 20 });
  const ch = fakeChannel();
  svc.handle(ch, { peer: 'u3', kind: 'text' }, false);
  await wait(80);
  assert.equal(ch.sent.length, 0);
  svc.dispose();
});

test('回执：通道不支持外发（无 send）时静默跳过，不抛错', async () => {
  const svc = new ReceiptService({ debounceMs: 20 });
  assert.doesNotThrow(() => svc.handle({ id: 'demo', name: '演示Bot' }, { peer: 'p', kind: 'text' }, true));
  await wait(80);
  svc.dispose();
});

test('回执：发送失败只记日志，不影响后续回执', async () => {
  const svc = new ReceiptService({ debounceMs: 20 });
  let calls = 0;
  const ch = {
    id: 'c2',
    send: async () => {
      calls += 1;
      throw new Error('未登录');
    },
  };
  svc.handle(ch, { peer: 'u4', kind: 'text' }, true);
  await wait(80);
  assert.equal(calls, 1);
  svc.dispose();
});

test('回执：纯表情文本归入「表情消息」', async () => {
  const svc = new ReceiptService({ debounceMs: 20 });
  const ch = fakeChannel();
  svc.handle(ch, { peer: 'u5', kind: 'text', text: '[裂开][旺柴]' }, true);
  await wait(80);
  assert.equal(ch.sent[0].text, `${expectedHeader()} 共收到 1 条消息\n表情消息 1 条`);
  svc.dispose();
});

// 回执抬头带日期（「YYYY年MM月DD日 共收到 N 条消息」），因此 N 必须是当天累计数，
// 而不是空闲窗口内那一批的数量。v1.0.31 用 3.5s 去抖 + 窗口内计数，
// 人类打字间隔普遍大于该窗口，结果每条消息各发一封且都报「共收到 1 条消息」。
test('回执：注入 countSince 时按"当天累计"计数，而不是只算本批次的 1 条', async () => {
  // 模拟：今天这个会话此前已累计 4 条文字 + 1 条图片
  const svc = new ReceiptService({ debounceMs: 20, countSince: async () => ({ text: 4, image: 1 }) });
  const ch = fakeChannel();
  svc.handle(ch, { peer: 'u6', kind: 'text' }, true);
  await wait(80);
  assert.equal(ch.sent[0].text, `${expectedHeader()} 共收到 5 条消息\n文字消息 4 条\n图片消息 1 条`);
  svc.dispose();
});

test('回执：countSince 传入的 sinceTs 是本地零点', async () => {
  let seen = null;
  const svc = new ReceiptService({ debounceMs: 20, countSince: async (_cid, _peer, since) => { seen = since; return { text: 1 }; } });
  const ch = fakeChannel();
  svc.handle(ch, { peer: 'u7', kind: 'text' }, true);
  await wait(80);
  const midnight = new Date();
  midnight.setHours(0, 0, 0, 0);
  assert.equal(seen, midnight.getTime());
  svc.dispose();
});

test('回执：sticker 与 emoji 合并为一行「表情消息」，不重复输出', async () => {
  const svc = new ReceiptService({ debounceMs: 20, countSince: async () => ({ sticker: 2, emoji: 3 }) });
  const ch = fakeChannel();
  svc.handle(ch, { peer: 'u8', kind: 'sticker' }, true);
  await wait(80);
  assert.equal(ch.sent[0].text, `${expectedHeader()} 共收到 5 条消息\n表情消息 5 条`);
  svc.dispose();
});

test('回执：空闲窗口内的新消息顺延计时，会话静默后才发一封', async () => {
  const svc = new ReceiptService({ debounceMs: 60, countSince: async () => ({ text: 1 }) });
  const ch = fakeChannel();
  svc.handle(ch, { peer: 'u9', kind: 'text' }, true);
  await wait(30);
  assert.equal(ch.sent.length, 0, '窗口未过半时不应发送');
  svc.handle(ch, { peer: 'u9', kind: 'text' }, true); // 顺延
  await wait(30);
  assert.equal(ch.sent.length, 0, '被新消息顺延后仍不应发送');
  await wait(60);
  assert.equal(ch.sent.length, 1, '会话静默满一个窗口后只发一封');
  svc.dispose();
});

test('回执：countSince 抛错时不发送回执，也不抛出到调用方', async () => {
  const svc = new ReceiptService({ debounceMs: 20, countSince: async () => { throw new Error('db down'); } });
  const ch = fakeChannel();
  svc.handle(ch, { peer: 'u10', kind: 'text' }, true);
  await wait(80);
  assert.equal(ch.sent.length, 0);
  svc.dispose();
});

test('回执：上下文 token 透传给 send，便于落到正确的会话', async () => {
  const svc = new ReceiptService({ debounceMs: 20, countSince: async () => ({ text: 1 }) });
  const seen = [];
  const ch = { id: 'c3', send: async (peer, text, ctx) => seen.push({ peer, text, ctx }) };
  svc.handle(ch, { peer: 'u11', kind: 'text', contextToken: 'ctx-abc' }, true);
  await wait(80);
  assert.equal(seen[0].ctx.contextToken, 'ctx-abc');
  assert.equal(seen[0].ctx.receipt, true);
  svc.dispose();
});
