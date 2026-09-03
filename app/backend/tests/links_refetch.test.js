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
import { assertPublicUrl, isInternalHostname, isLiteralIp } from '../src/ssrf.js';

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
  const realFetch = global.fetch;
  const origLookup = dns.lookup;
  const html = '<html><head><meta property="og:title" content="重抓标题"><title>t</title></head><body>hi</body></html>';
  // 桩 fetch / dns.lookup：模拟"联网后"可抓取。
  // 注意只桩「外部网页」类请求（非 127.0.0.1），测试自身命中本机 server 的 fetch 仍走真实 fetch，
  // 否则 res.json 会被桩对象覆盖而报「is not a function」。
  global.fetch = (url, opts) => {
    if (typeof url === 'string' && url.startsWith('http://127.0.0.1')) return realFetch(url, opts);
    return Promise.resolve({
      ok: true,
      status: 200,
      headers: { get: () => null },
      arrayBuffer: async () => new TextEncoder().encode(html).buffer,
    });
  };
  dns.lookup = async () => [{ address: '93.184.216.34', family: 4 }];
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
    global.fetch = realFetch;
    dns.lookup = origLookup;
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
