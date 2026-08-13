import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FileDropProvider } from '../src/providers/filedrop.js';

// 构造一个最小可用的 fake channel：Provider 只依赖 channel.providerConfig 与 channel.deliver/_emitStatus
function fakeChannel(cfg = {}, captured = []) {
  return {
    providerConfig: cfg,
    delivered: captured,
    async deliver(msg) {
      captured.push(msg);
    },
    _emitStatus() {},
  };
}

test('filedrop: 未配置 path 时视为未连接', async () => {
  const ch = fakeChannel({});
  const p = new FileDropProvider({ channel: ch });
  assert.equal(p._configured(), false);
  await p.startLogin();
  assert.equal(p.channel.loggedIn, false);
});

test('filedrop: 把文本文件归一化为一条 text 消息（peer=文件名）', async () => {
  const captured = [];
  const ch = fakeChannel({ path: '/tmp/x', delete_after: false }, captured);
  const p = new FileDropProvider({
    channel: ch,
    readFile: async () => '这是一段要归档的对话内容',
    watch: () => ({ close() {} }),
  });
  const ok = await p.ingestFile('/whatever/笔记.md');
  assert.equal(ok, true);
  assert.equal(captured.length, 1);
  const m = captured[0];
  assert.equal(m.kind, 'text');
  assert.equal(m.peer, '笔记.md');
  assert.match(m.text, /归档的对话内容/);
});

test('filedrop: 不匹配后缀的文件被忽略', async () => {
  const captured = [];
  const ch = fakeChannel({ path: '/tmp/x' }, captured);
  const p = new FileDropProvider({ channel: ch, readFile: async () => 'x', watch: () => ({ close() {} }) });
  const ok = await p.ingestFile('/whatever/photo.png');
  assert.equal(ok, false);
  assert.equal(captured.length, 0);
});

test('filedrop: 空文件不投递', async () => {
  const captured = [];
  const ch = fakeChannel({ path: '/tmp/x' }, captured);
  const p = new FileDropProvider({ channel: ch, readFile: async () => '   ', watch: () => ({ close() {} }) });
  assert.equal(await p.ingestFile('/whatever/empty.txt'), false);
  assert.equal(captured.length, 0);
});

test('filedrop: delete_after 投递后删除源文件（真实 fs）', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fnclaw-fd-'));
  const fp = path.join(dir, 'a.txt');
  fs.writeFileSync(fp, 'hello');
  const captured = [];
  const p = new FileDropProvider({ channel: fakeChannel({ path: dir, delete_after: true }, captured) });
  const ok = await p.ingestFile(fp);
  assert.equal(ok, true);
  assert.equal(fs.existsSync(fp), false, '投递后源文件应被删除');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('filedrop: start() 扫描已有文件并投递；stop() 清理 watcher', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fnclaw-fd-'));
  fs.writeFileSync(path.join(dir, 'one.txt'), '消息一');
  fs.writeFileSync(path.join(dir, 'two.md'), '消息二');
  const captured = [];
  const p = new FileDropProvider({ channel: fakeChannel({ path: dir }, captured), watch: () => ({ close() {} }) });
  p.resume(); // 配置齐全 → 置为已连接并 start()
  // 扫描是同步触发投递（异步链路），稍等
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(p.channel.loggedIn, true);
  assert.ok(captured.length >= 2, `应归档已有 2 个文件，实际 ${captured.length}`);
  p.stop();
  assert.equal(p._running, false);
  fs.rmSync(dir, { recursive: true, force: true });
});
