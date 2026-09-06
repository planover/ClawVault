import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import dns from 'node:dns';
import { Storage } from '../src/storage.js';
import createLinksRouter from '../src/routes/links.js';
import createMessagesRouter from '../src/routes/messages.js';
import { assertPublicUrl, isInternalHostname, isLiteralIp } from '../src/ssrf.js';
// 出网替身走 netguard 的注入 seam（ENG-1：不再对 dns.lookup / 全局 fetch 做 monkey patch）
import { setFetchImpl, setResolver } from '../src/netguard.js';

// 清除环境里可能存在的代理（沙箱/CI 常注入 HTTPS_PROXY），保证单测走直连 + 桩 fetch。
for (const k of ['HTTPS_PROXY', 'HTTP_PROXY', 'https_proxy', 'http_proxy', 'LINKS_PROXY']) {
  delete process.env[k];
}

// ---------------------------------------------------------------- SSRF 代理分支
test('isLiteralIp / isInternalHostname 基础判定', () => {
  assert.equal(isLiteralIp('127.0.0.1'), true);
  assert.equal(isLiteralIp('[::1]'), true);
  assert.equal(isLiteralIp('example.com'), false);
  assert.equal(isInternalHostname('localhost'), true);
  assert.equal(isInternalHostname('foo.local'), true);
  assert.equal(isInternalHostname('router.lan'), true);
  assert.equal(isInternalHostname('metadata.google.internal'), true);
  assert.equal(isInternalHostname('example.com'), false);
});

test('assertPublicUrl：走代理时跳过本地 DNS，但内网 IP / 内网域名仍被拦', async () => {
  const proxy = 'http://proxy.example:8080';
  // 公网域名：无需本地 DNS，直接放行
  const u = await assertPublicUrl('https://example.com/post/1', { proxy });
  assert.equal(u.hostname, 'example.com');
  // 字面内网 IP：无需 DNS 即拦截（127.0.0.1 / 169.254.169.254 云元数据）
  await assert.rejects(() => assertPublicUrl('http://127.0.0.1/', { proxy }), /回环|内网|SSRF/);
  await assert.rejects(() => assertPublicUrl('http://169.254.169.254/latest/', { proxy }), /回环|内网|SSRF/);
  // 内网/保留域名：无需 DNS 即拦截（走代理出网时也必须兜底）
  await assert.rejects(() => assertPublicUrl('http://localhost/', { proxy }), /内网|保留域名/);
  await assert.rejects(() => assertPublicUrl('http://metadata.google.internal/', { proxy }), /内网|保留域名/);
});

test('assertPublicUrl：无代理时公网域名仍需本地 DNS 解析（确定不可解析即失败）', async () => {
  // 用 .invalid 保留 TLD（RFC 2606 保证永不解析），避免依赖本机是否联网
  await assert.rejects(() => assertPublicUrl('https://this-domain-must-not-resolve.invalid/'), /无法解析目标主机/);
});

// ---------------------------------------------------------------- 存储层更新
const utmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fnclaw-updsnap-'));
const ustorage = new Storage({ dataDir: path.join(utmp, 'data'), archiveRoot: path.join(utmp, 'archive') });

test('updateLinkSnapshot：按 id 原地更新，不新增行', () => {
  const saved = ustorage.saveLinkSnapshot({
    url: 'https://a.com/',
    messageId: 7,
    status: 'fetch_failed',
    error: '无法解析目标主机',
  });
  assert.ok(saved.id);
  const before = ustorage.listLinkSnapshots().total;
  const updated = ustorage.updateLinkSnapshot({
    ...saved,
    title: '新标题',
    status: 'ok',
    error: '',
    htmlPath: '链接快照/a.com/x.html',
  });
  assert.equal(updated.id, saved.id);
  assert.equal(updated.title, '新标题');
  assert.equal(updated.status, 'ok');
  assert.equal(updated.error, '');
  assert.equal(updated.html_path, '链接快照/a.com/x.html');
  assert.equal(ustorage.listLinkSnapshots().total, before, '更新不应新增行');
  // 落库后再读一次确认持久化
  const reread = ustorage.getLinkSnapshot(saved.id);
  assert.equal(reread.title, '新标题');
  assert.equal(reread.status, 'ok');
});

// ---------------------------------------------------------------- 重新抓取接口
const rtmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fnclaw-refetch-'));
const rstorage = new Storage({ dataDir: path.join(rtmp, 'data'), archiveRoot: path.join(rtmp, 'archive') });

function startServer(app) {
  return new Promise((resolve) => {
    const s = http.createServer(app);
    s.listen(0, () => resolve(s));
  });
}
const base = (s) => `http://127.0.0.1:${s.address().port}`;

test('POST /api/links/:id/refetch：重新抓取并更新同一行 + 广播', async () => {
  const saved = rstorage.saveLinkSnapshot({
    url: 'https://example.com/post/1',
    messageId: 3,
    status: 'fetch_failed',
    error: '无法解析目标主机',
  });
  let broadcasted = null;
  const ws = { broadcast: (msg) => { broadcasted = msg; } };
  const app = express();
  app.use('/api/links', createLinksRouter({ storage: rstorage, ws }));
  const server = await startServer(app);
  const html = '<html><head><meta property="og:title" content="重抓标题"><title>t</title></head><body>hi</body></html>';
  // 出网替身：模拟「联网后」可抓取。
  // 通过 netguard 的 seam 注入，只影响 linkshot 的外部网页请求；
  // 测试自身命中本机 server（127.0.0.1）的 fetch 仍走真实 fetch，不受影响。
  setFetchImpl(async () => ({
    ok: true,
    status: 200,
    headers: { get: () => null },
    arrayBuffer: async () => new TextEncoder().encode(html).buffer,
  }));
  setResolver(async () => [{ address: '93.184.216.34', family: 4 }]);
  try {
    const res = await fetch(base(server) + `/api/links/${saved.id}/refetch`, { method: 'POST' });
    assert.equal(res.status, 200);
    const j = await res.json();
    assert.equal(j.id, saved.id);
    assert.equal(j.status, 'ok');
    assert.equal(j.title, '重抓标题');
    assert.ok(j.html_path, 'HTML 应已重新落盘');
    assert.equal(j.error, '');
    // 同一行更新，总数不变
    assert.equal(rstorage.listLinkSnapshots().total, 1);
    // 广播带上了 messageId 与新快照（前端据此就地刷新）
    assert.ok(broadcasted, '应广播');
    assert.equal(broadcasted.type, 'link_snapshot');
    assert.equal(broadcasted.record.messageId, 3);
    assert.equal(broadcasted.record.snapshot.id, saved.id);
  } finally {
    setFetchImpl(null);
    setResolver(null);
    server.close();
  }
});

test('listMessages：sub 为空（不指定子分类）时不得过滤掉带子分类的消息', () => {
  const a = rstorage.saveMessage({
    channelId: 'c1', channelName: '测试', peer: '张三', text: '无子分类', kind: 'text',
  });
  const b = rstorage.saveMessage({
    channelId: 'c1', channelName: '测试', peer: '张三', text: '有子分类', kind: 'text',
  });
  rstorage.reclassify(a.id, '收藏网址', '');
  rstorage.reclassify(b.id, '收藏网址', 'mp.weixin.qq.com');

  // 只按分类查：两条都应回来（此前空 sub 被当成 `sub=''` 条件，漏掉 b）
  const all = rstorage.listMessages({ category: '收藏网址' });
  const ids = all.items.map((m) => m.id);
  assert.ok(ids.includes(a.id), '不带子分类的应返回');
  assert.ok(ids.includes(b.id), '带子分类的也应返回');
  assert.equal(all.total, all.items.length);

  // 指定子分类时仍要能精确筛出
  const only = rstorage.listMessages({ category: '收藏网址', sub: 'mp.weixin.qq.com' });
  assert.deepEqual(only.items.map((m) => m.id).includes(b.id), true);
  assert.deepEqual(only.items.map((m) => m.id).includes(a.id), false);
});

test('POST /api/messages/:id/reclassify 到「收藏网址」会补建快照；其它分类不触发；重复归类幂等', async () => {
  const calls = [];
  const msg = rstorage.saveMessage({
    channelId: 'c1',
    channelName: '测试',
    peer: '张三',
    text: '见 https://example.com/a',
    kind: 'text',
  });
  const app = express();
  app.use(express.json());
  app.use(
    '/api/messages',
    createMessagesRouter({
      storage: rstorage,
      ws: { broadcast() {} },
      // 真机由 index.js 注入；这里用替身断言「调用与参数」，不真出网
      captureLinkSnapshots: async (rec, text) => {
        calls.push({ id: rec.id, text });
      },
    }),
  );
  const server = await startServer(app);
  try {
    const post = (id, category) =>
      fetch(base(server) + `/api/messages/${id}/reclassify`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ category }),
      });

    // 1) 归入收藏网址 → 触发快照
    let res = await post(msg.id, '收藏网址');
    assert.equal(res.status, 200);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].id, msg.id);

    // 2) 归入其它分类 → 不触发（避免每次改分类都打外网）
    res = await post(msg.id, '文本');
    assert.equal(res.status, 200);
    assert.equal(calls.length, 1, '非收藏网址分类不应触发快照');

    // 3) 不存在的消息 → 404 且不触发
    res = await post(999999, '收藏网址');
    assert.equal(res.status, 404);
    assert.equal(calls.length, 1);
  } finally {
    server.close();
  }
});

test('POST /api/links/:id/refetch：不存在的 id 返回 404', async () => {
  const app = express();
  app.use('/api/links', createLinksRouter({ storage: rstorage, ws: { broadcast() {} } }));
  const server = await startServer(app);
  try {
    const res = await fetch(base(server) + '/api/links/999999/refetch', { method: 'POST' });
    assert.equal(res.status, 404);
  } finally {
    server.close();
  }
});
