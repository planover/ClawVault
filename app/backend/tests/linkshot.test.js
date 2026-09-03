import test from 'node:test';
import assert from 'node:assert/strict';
import dns from 'node:dns';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import config from '../src/config.js';
import {
  extractUrls,
  isPureUrl,
  urlDomain,
  parseMetadata,
  snapshotPaths,
  createSnapshot,
  LINK_CATEGORY,
} from '../src/linkshot.js';
import { assertPublicUrl, isPrivateIp } from '../src/ssrf.js';

// 清除环境里可能存在的代理（沙箱/CI 常注入 HTTPS_PROXY），保证单测走直连 + 桩 fetch，
// 不被意外代理劫持（生产态仍按 LINKS_PROXY / HTTPS_PROXY 出网）。
for (const k of ['HTTPS_PROXY', 'HTTP_PROXY', 'https_proxy', 'http_proxy', 'LINKS_PROXY']) {
  delete process.env[k];
}

// ---------------------------------------------------------------- URL 提取
test('extractUrls：空文本返回空数组', () => {
  assert.deepEqual(extractUrls(''), []);
  assert.deepEqual(extractUrls('   '), []);
  assert.deepEqual(extractUrls(null), []);
});

test('extractUrls：从正文里提取 http(s) 链接', () => {
  const got = extractUrls('看看这个 https://example.com/a?b=1 和 https://test.org');
  // new URL().href 会补全尾斜杠，属预期行为
  assert.deepEqual(got, ['https://example.com/a?b=1', 'https://test.org/']);
});

test('extractUrls：同一条链接重复出现只保留一次', () => {
  const got = extractUrls('https://example.com/x 再看 https://example.com/x');
  assert.deepEqual(got, ['https://example.com/x']);
});

test('extractUrls：limit 参数限制单条消息抓取数量', () => {
  const text = 'https://a.com https://b.com https://c.com https://d.com';
  assert.deepEqual(extractUrls(text, { limit: 1 }), ['https://a.com/']);
  assert.deepEqual(extractUrls(text, { limit: 2 }), ['https://a.com/', 'https://b.com/']);
});

test('extractUrls：剔除尾部中英文标点与全角括号', () => {
  assert.deepEqual(extractUrls('见（https://example.com）。'), ['https://example.com/']);
  assert.deepEqual(extractUrls('点 https://example.com/path, 再看'), ['https://example.com/path']);
});

// ---------------------------------------------------------------- 纯网址判定
test('isPureUrl：整条消息就是一个网址时为真', () => {
  assert.equal(isPureUrl('https://example.com'), true);
  assert.equal(isPureUrl('http://example.com/path?q=1'), true);
});

test('isPureUrl：含空白或非链接文本时为假', () => {
  assert.equal(isPureUrl('看 https://example.com'), false); // 中间有空白 → 不是"单独"
  assert.equal(isPureUrl('https://example.com x'), false);
  assert.equal(isPureUrl('ftp://example.com'), false);
  assert.equal(isPureUrl('随便一段文字'), false);
  // 前后空白的纯网址：trim 后无空白，仍视为纯网址（聊天里偶尔带首尾空格）
  assert.equal(isPureUrl(' https://example.com '), true);
});

test('urlDomain：去掉 www. 前缀', () => {
  assert.equal(urlDomain('https://www.example.com/a'), 'example.com');
  assert.equal(urlDomain('https://sub.example.com'), 'sub.example.com');
});

// ---------------------------------------------------------------- 元数据解析
test('parseMetadata：优先读 og: 标签，回退 <title>', () => {
  const html = `<html><head>
    <meta property="og:title" content="OG 标题">
    <meta property="og:description" content="OG 摘要 &amp; 转义">
    <meta property="og:image" content="/img/cover.png">
    <title>HTML 标题</title>
  </head></html>`;
  const meta = parseMetadata(html, 'https://example.com/post/1');
  assert.equal(meta.title, 'OG 标题');
  assert.equal(meta.description, 'OG 摘要 & 转义'); // HTML 实体被解码
  assert.equal(meta.domain, 'example.com');
  assert.equal(meta.coverUrl, 'https://example.com/img/cover.png'); // 相对地址被补全为绝对地址（SSRF 防护末端）
});

test('parseMetadata：无 og:title 时回退到 <title>', () => {
  const meta = parseMetadata('<title>纯标题</title>', 'https://example.com');
  assert.equal(meta.title, '纯标题');
});

test('LINK_CATEGORY 常量用于「收藏网址」顶级分类', () => {
  assert.equal(LINK_CATEGORY, '收藏网址');
});

// ---------------------------------------------------------------- 文件布局
test('snapshotPaths：归档落在「链接快照/<域名>/<时间戳>-<短hash>.html」', () => {
  const p = snapshotPaths('/archive', 'https://www.example.com/a?b=1', 1700000000000);
  assert.ok(p.htmlRel.startsWith('链接快照/example.com/'));
  assert.ok(p.htmlRel.endsWith('.html'));
  assert.ok(p.shotRel.endsWith('.png'));
  assert.ok(/-\w{8}$/.test(path.basename(p.htmlRel, '.html'))); // 含 sha256 前 8 位
});

// ---------------------------------------------------------------- SSRF 防护
test('isPrivateIp：识别常见私网/回环/链路本地地址', () => {
  for (const ip of ['127.0.0.1', '10.0.0.5', '172.16.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '::1', 'fc00::1']) {
    assert.equal(isPrivateIp(ip), true, ip);
  }
  for (const ip of ['8.8.8.8', '1.1.1.1', '203.0.113.5', '2606:4700::1']) {
    assert.equal(isPrivateIp(ip), false, ip);
  }
});

test('assertPublicUrl：拒绝私网/回环/云元数据地址', async () => {
  for (const raw of [
    'http://127.0.0.1/',
    'http://10.0.0.1/secret',
    'http://169.254.169.254/latest/meta-data/',
    'https://192.168.1.1/',
    'http://localhost/',
  ]) {
    await assert.rejects(() => assertPublicUrl(raw), /内网|回环|SSRF|主机/);
  }
});

test('assertPublicUrl：拒绝非 http(s) 与含账号密码的链接', async () => {
  await assert.rejects(() => assertPublicUrl('ftp://example.com/'), /http\/https/);
  await assert.rejects(() => assertPublicUrl('http://user:pw@1.2.3.4/'), /用户名密码/);
});

// ---------------------------------------------------------------- 截图优雅降级
test('createSnapshot：无浏览器时仍落盘 HTML 元数据，截图优雅跳过（不抛异常）', async () => {
  const archiveRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fnclaw-snap-'));
  const origFetch = global.fetch;
  const origLookup = dns.lookup;
  const html = `<html><head>
    <meta property="og:title" content="示例标题">
    <meta property="og:description" content="示例摘要文本">
    <title>回退</title></head><body>内容</body></html>`;
  // 桩掉 fetch：始终返回同一段 HTML，避免真实外网请求（也顺带验证 fetchPage 解析路径）
  global.fetch = async () => ({
    ok: true,
    status: 200,
    headers: { get: () => null },
    arrayBuffer: async () => new TextEncoder().encode(html).buffer,
  });
  // 桩掉 dns.lookup：让 assertPublicUrl 的 SSRF 校验离线也能通过（解析到任意公网 IP）
  dns.lookup = async () => [{ address: '93.184.216.34', family: 4 }];

  const savedChromium = config.links?.chromiumPath;
  let rec;
  try {
    rec = await createSnapshot('https://example.com/post/1', { archiveRoot, ts: 1700000000000 });
  } finally {
    global.fetch = origFetch;
    dns.lookup = origLookup;
    config.links && (config.links.chromiumPath = savedChromium);
  }

  // 核心资产：HTML 归档落盘 + 元数据解析成功
  assert.ok(rec.htmlPath, 'HTML 应已落盘');
  const abs = path.join(archiveRoot, rec.htmlPath);
  assert.ok(fs.existsSync(abs), '归档文件应存在');
  assert.equal(rec.title, '示例标题');
  assert.equal(rec.description, '示例摘要文本');
  assert.equal(rec.domain, 'example.com');
  assert.equal(rec.status, 'ok');

  // 截图是渐进增强：装了浏览器就抓（screenshotPath 非空、无原因），
  // 没装就优雅跳过（screenshotPath 留空 + 记录原因）。两种环境都不应抛异常、不影响核心资产。
  // 关键不变量：screenshotPath 与 screenshotError 互斥（恰好一个存在）。
  const hasShot = Boolean(rec.screenshotPath);
  const hasReason = Boolean(rec.screenshotError);
  assert.ok(hasShot !== hasReason, `截图与跳过原因应互斥：path=${rec.screenshotPath} reason=${rec.screenshotError}`);
  if (!hasShot) {
    assert.ok(
      ['no_browser', 'no_playwright', 'capture_failed', 'disabled'].includes(rec.screenshotError),
      `跳过截图应给出明确原因，实际=${rec.screenshotError}`,
    );
  }
  // 清理
  fs.rmSync(archiveRoot, { recursive: true, force: true });
});
