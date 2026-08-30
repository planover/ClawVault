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
