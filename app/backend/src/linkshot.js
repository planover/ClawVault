import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import config from './config.js';
import { assertPublicUrl } from './ssrf.js';
// 出网统一走 netguard.safeFetch（SSRF 校验 + DNS 钉住 + 超时 + 体积上限），
// 代理能力也一并封装在 netguard 里（undici ProxyAgent）。
// 测试替身通过 netguard 的 setFetchImpl 注入，不再对全局 fetch 做 monkey patch。
import { safeFetch } from './netguard.js';

// 网址快照引擎：消息里出现 http(s) 链接时，把网页存成三份资产——
//   1) 元数据卡片：标题 / 摘要 / 站点名 / 封面图（秒级可用，零外部依赖）
//   2) HTML 全文归档：原始 HTML 落盘，链接失效后仍可离线打开
//   3) 网页截图：best-effort，需要 Chromium（opt-in，见 resolveChromium）
//
// 设计取舍：
//   - 本模块刻意**不 import storage.js**，只做「抓取 + 落盘 + 返回相对路径」，
//     由调用方（index.js）负责入库。这样既可单测（传临时目录），也避免循环依赖。
//   - 截图是渐进增强：没装浏览器时 status 记为 'no_browser'，另外两份资产照常保存，
//     功能不整体失败。
//   - 所有对外请求走 assertPublicUrl，且重定向逐跳复检（防 302 跳内网绕过 SSRF）。

// 纯网址消息归入该顶级分类
export const LINK_CATEGORY = '收藏网址';

// 快照在归档根目录下的存放位置：链接快照/<域名>/<时间戳>-<短hash>.html
export const SNAPSHOT_ROOT = '链接快照';

const UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Chrome/120.0 Safari/537.36 ClawVaultBot/1.0';

// ---------------------------------------------------------------- 代理出网
// 说明（2026-09-04 真机复核修正）：早期记录「fnOS 应用沙箱本地无出站 DNS」，
// 该结论**已过时**。在飞牛真机上以应用自带 Node、以 clawvault 身份实测，
// 直连 fetch('https://mp.weixin.qq.com/...') 返回 200、dns 解析正常
// （DNS 由 Tailscale 100.100.100.100 提供）。因此**默认直连即可抓**，无需代理。
// 代理保留为可选能力：某些网络环境（或用户希望固定出口）仍可配置，
// 优先级：settings(links.proxy) > HTTPS_PROXY > HTTP_PROXY。
function resolveProxy() {
  const p =
    config.links?.proxy ||
    process.env.HTTPS_PROXY ||
    process.env.https_proxy ||
    process.env.HTTP_PROXY ||
    process.env.http_proxy ||
    '';
  return p || null;
}

// 统一出口（SEC-02 / SEC-08）：全部走 netguard.safeFetch。
//   - 无代理：先解析并校验主机、把地址钉住后再建连，杜绝 DNS Rebinding；
//   - 有代理：经代理出网，DNS 由代理侧解析（代理被视为用户受信出网通道）。
// 体积上限与超时一并由 safeFetch 处理。
// 注意：这里**不再**用被测试打桩的全局 fetch，改由 netguard 的 setFetchImpl
// 提供注入 seam——此前对全局 fetch / dns.lookup 做 monkey patch，
// 恰好掩盖了 ssrf.js 里 dns.lookup 缺回调的真实签名错误（130 个测试全绿、生产全挂）。
function doFetch(url, opts = {}) {
  return safeFetch(url, { ...opts, proxy: resolveProxy() });
}

// ---------------------------------------------------------------- URL 提取

// 从任意文本里提取 http(s) 链接。
// 边界处理：Unicode 全角括号/引号不算链接的一部分，避免把「（见 https://x.com）」
// 里的右括号吞进去；尾部中英文标点剔除；同文重复链接去重。
const URL_RE = /https?:\/\/[^\s<>"'）)】\]「」《》]+/gi;

export function extractUrls(text, { limit } = {}) {
  const max = limit ?? config.links?.maxUrlsPerMessage ?? 3;
  const src = String(text || '');
  if (!src) return [];
  const out = [];
  const seen = new Set();
  const matches = src.match(URL_RE) || [];
  for (let raw of matches) {
    // 剔除结尾的中英文标点（链接本身极少以标点结尾）
    raw = raw.replace(/[.,;:!?'"’，。；：！？、）》】\]]+$/g, '');
    let u;
    try {
      u = new URL(raw);
    } catch {
      continue;
    }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') continue;
    if (seen.has(u.href)) continue;
    seen.add(u.href);
    out.push(u.href);
    if (out.length >= max) break;
  }
  return out;
}

// 整条消息是否**就是**一个网址（前后允许空白）。
// 与 extractUrls 分开实现：用 href 回比会误判（new URL 会补尾斜杠），
// 这里直接判「无空白 + 单链接 + 可解析」更贴合"单独发送一条网址"的语义。
export function isPureUrl(text) {
  const t = String(text || '').trim();
  if (!t || /\s/.test(t)) return false;
  if (!/^https?:\/\//i.test(t)) return false;
  try {
    new URL(t);
    return true;
  } catch {
    return false;
  }
}

// 取网址的域名（去掉 www），用于「收藏网址」按站点做子分类。
// 与 parseMetadata 的 domain 同源口径，保证分类树与卡片显示的分组一致。
export function urlDomain(text) {
  try {
    return new URL(String(text).trim()).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

// ---------------------------------------------------------------- HTML 解析

const ENTITIES = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  '#39': "'",
  '#34': '"',
};

function decodeEntities(s) {
  return String(s || '')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&([a-z0-9#]+);/gi, (m, n) => ENTITIES[n.toLowerCase()] ?? m)
    .replace(/\s+/g, ' ')
    .trim();
}

// 把一个标签内的属性抽成 {小写名: 值}。属性值三种写法都支持：双引/单引/裸值。
function tagAttrs(tag) {
  const attrs = {};
  const re = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g;
  let m;
  while ((m = re.exec(tag))) {
    attrs[m[1].toLowerCase()] = m[2] ?? m[3] ?? m[4] ?? '';
  }
  return attrs;
}

// 收集 <meta> 的 property/name → content。
// 用「先抓整段标签再解析属性」而不是顺序硬编码的正则，
// 因为 content 与 property 的先后在各站点并不一致。
function metaMap(html) {
  const map = new Map();
  const re = /<meta\b[^>]*>/gi;
  let m;
  while ((m = re.exec(html))) {
    const a = tagAttrs(m[0]);
    const key = String(a.property || a.name || '').toLowerCase();
    if (key && a.content && !map.has(key)) map.set(key, a.content);
  }
  return map;
}

// favicon：<link rel="icon|shortcut icon|apple-touch-icon" href=...>
function faviconHref(html) {
  const re = /<link\b[^>]*>/gi;
  let m;
  let fallback = '';
  while ((m = re.exec(html))) {
    const a = tagAttrs(m[0]);
    const rel = String(a.rel || '').toLowerCase();
    if (!rel || !a.href) continue;
    if (/\b(shortcut\s+)?icon\b/.test(rel)) return a.href;
    if (rel.includes('apple-touch-icon') && !fallback) fallback = a.href;
  }
  return fallback;
}

function absolutize(maybeRelative, baseUrl) {
  if (!maybeRelative) return '';
  try {
    return new URL(maybeRelative, baseUrl).href;
  } catch {
    return '';
  }
}

// 从 HTML 里解析出卡片所需元数据（纯函数，便于单测）
export function parseMetadata(html, baseUrl) {
  const src = String(html || '');
  const meta = metaMap(src);
  const titleRaw =
    meta.get('og:title') ||
    meta.get('twitter:title') ||
    (src.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? '');
  const descRaw =
    meta.get('og:description') || meta.get('description') || meta.get('twitter:description') || '';
  const imageRaw = meta.get('og:image') || meta.get('twitter:image') || '';
  const siteName = meta.get('og:site_name') || '';

  let host = '';
  try {
    host = new URL(baseUrl).hostname;
  } catch {
    host = '';
  }

  return {
    title: decodeEntities(titleRaw).slice(0, 300) || host,
    description: decodeEntities(descRaw).slice(0, 1000),
    siteName: decodeEntities(siteName).slice(0, 120),
    domain: host.replace(/^www\./, ''),
    coverUrl: absolutize(imageRaw, baseUrl),
    faviconUrl: absolutize(faviconHref(src), baseUrl) || absolutize('/favicon.ico', baseUrl),
  };
}

// ---------------------------------------------------------------- 抓取

// 抓取网页。手动处理重定向以逐跳做 SSRF 校验——
// 这是链接预览类功能最容易被绕过的一环（公网域名 302 跳 127.0.0.1 / 169.254.169.254）。
// 超时与体积上限由 netguard.safeFetch 统一处理（不再自己读流）。
export async function fetchPage(url, { timeoutMs, maxBytes, maxRedirects = 5 } = {}) {
  const tmo = timeoutMs ?? config.links?.timeoutMs ?? 15000;
  const cap = maxBytes ?? config.links?.maxBytes ?? 2 * 1024 * 1024;
  let current = url;
  for (let hop = 0; hop <= maxRedirects; hop++) {
    // assertPublicUrl 负责策略（协议 / 字面私网 / 保留域名 / 解析后判私网），
    // safeFetch 负责把校验通过的地址钉住再建连（防 DNS Rebinding）。
    const safe = await assertPublicUrl(current, { proxy: resolveProxy() });
    const res = await doFetch(safe.href, {
      timeoutMs: tmo,
      maxBytes: cap,
      headers: { 'user-agent': UA, accept: 'text/html,application/xhtml+xml,*/*;q=0.8' },
    });
    const loc = res.headers.get('location');
    if (res.status >= 300 && res.status < 400 && loc) {
      current = new URL(loc, safe.href).href;
      continue;
    }
    if (!res.ok) throw new Error(`网页返回 ${res.status}`);
    return { html: res.buffer.toString('utf8'), finalUrl: safe.href, status: res.status };
  }
  throw new Error('重定向次数过多');
}

// 下载封面图（同样走 SSRF 校验 + 钉 IP + 体积上限），返回 buffer 与扩展名
export async function fetchImage(url, { timeoutMs, maxBytes } = {}) {
  const tmo = timeoutMs ?? config.links?.timeoutMs ?? 15000;
  const cap = maxBytes ?? config.links?.maxBytes ?? 2 * 1024 * 1024;
  const safe = await assertPublicUrl(url, { proxy: resolveProxy() });
  const res = await doFetch(safe.href, {
    timeoutMs: tmo,
    maxBytes: cap,
    headers: { 'user-agent': UA, accept: 'image/*' },
  });
  if (!res.ok) throw new Error(`图片返回 ${res.status}`);
  const ct = String(res.headers.get('content-type') || '').toLowerCase();
  const ext = ct.includes('png')
    ? 'png'
    : ct.includes('gif')
      ? 'gif'
      : ct.includes('webp')
        ? 'webp'
        : 'jpg';
  return { buffer: res.buffer, ext };
}

// ---------------------------------------------------------------- 落盘

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function safeName(name, max = 60) {
  return String(name || 'unknown')
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/\s+/g, '_')
    .slice(0, max);
}

function stamp(ts) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

// 计算本次快照的文件布局（相对归档根目录的 posix 路径）
export function snapshotPaths(archiveRoot, url, ts = Date.now()) {
  let host = 'unknown';
  try {
    host = new URL(url).hostname.replace(/^www\./, '');
  } catch {
    /* 保留 unknown */
  }
  const short = crypto.createHash('sha256').update(String(url)).digest('hex').slice(0, 8);
  const base = `${stamp(ts)}-${short}`;
  const relDir = `${SNAPSHOT_ROOT}/${safeName(host)}`;
  return {
    dir: path.join(archiveRoot, relDir),
    base,
    htmlRel: `${relDir}/${base}.html`,
    coverRel: `${relDir}/${base}.cover`, // 真实扩展名下载后补上
    shotRel: `${relDir}/${base}.png`,
  };
}

function writeFile(absPath, data) {
  ensureDir(path.dirname(absPath));
  fs.writeFileSync(absPath, data);
}

// ---------------------------------------------------------------- 截图（opt-in）

// 找一个可用的 Chromium：配置 → 环境变量 → 常见路径。
// 刻意不做自动安装：fnOS 上 Chromium 需要 14 个系统库（libnss3/libgbm/...），
// 强行打包会让 fpk 从 106MB 涨到 400MB+ 且仍可能跑不起来，
// 因此做成 opt-in，缺浏览器时优雅降级，其余两份资产照常保存。
export function resolveChromium() {
  const candidates = [
    config.links?.chromiumPath,
    process.env.CLAWVAULT_CHROMIUM,
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
  ].filter(Boolean);
  for (const c of candidates) {
    try {
      if (fs.existsSync(c)) return c;
    } catch {
      /* 忽略无权限等 */
    }
  }
  return '';
}

let _pwCache;
async function loadPlaywright() {
  if (_pwCache !== undefined) return _pwCache;
  try {
    _pwCache = await import('playwright-core');
  } catch {
    _pwCache = null; // 未安装 playwright-core：截图不可用，其余功能不受影响
  }
  return _pwCache;
}

// 抓取整页截图。返回 { ok, reason?, error? }，绝不抛异常。
export async function captureScreenshot(url, absOutPath, { timeoutMs } = {}) {
  if (config.links?.screenshot === false) return { ok: false, reason: 'disabled' };
  // FUN-3：真机（fnOS）通常没有 Chromium，fpk 也不适合塞进几百 MB 的浏览器。
  // 若用户已有一个浏览器服务（如宿主机 docker 里的 browserless/chrome），
  // 可用 CDP 端点接进来。这是 opt-in，留空时行为与之前完全一致。
  const cdp = String(config.links?.cdpEndpoint || process.env.CLAWVAULT_CDP || '').trim();
  const exe = resolveChromium();
  if (!cdp && !exe) return { ok: false, reason: 'no_browser' };
  const pw = await loadPlaywright();
  if (!pw) return { ok: false, reason: 'no_playwright' };

  const tmo = timeoutMs ?? config.links?.timeoutMs ?? 15000;
  const proxy = resolveProxy();
  let browser;
  let closeBrowser = true;
  try {
    // 出网前再校验一次目标：Chromium 会自己再解析一次 DNS，
    // 不能因为 fetch 阶段校验过就假定此处安全。
    const safe = await assertPublicUrl(url, { proxy });

    if (cdp) {
      // 连接已有浏览器服务：不负责启停，用 close() 会杀掉别人的容器，
      // 因此只关闭自己打开的 page / context。
      browser = await pw.chromium.connectOverCDP(cdp);
      closeBrowser = false;
    } else {
      // SEC-10：**默认开启 Chromium 沙箱**。--no-sandbox 会让渲染器直接以应用用户
      // 权限运行，一旦 Chromium 自身存在漏洞即可逃逸到宿主机，把「渲染一个外部网页」
      // 变成 RCE。仅当用户明确设置 CHROMIUM_NO_SANDBOX=true（确实受限的容器环境）
      // 才关闭沙箱，并打印告警。
      const args = ['--disable-dev-shm-usage', '--disable-gpu'];
      if (config.links?.chromiumNoSandbox === true) {
        console.warn('[ClawVault] 警告：已按配置关闭 Chromium 沙箱（--no-sandbox），仅在受限容器中使用');
        args.push('--no-sandbox');
      }
      const launchOpts = { executablePath: exe, args };
      // 走代理出网时，截图也经由同一代理，才能抓到联网后的页面
      if (proxy) launchOpts.proxy = { server: proxy };
      browser = await pw.chromium.launch(launchOpts);
    }

    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    try {
      await page.goto(safe.href, { waitUntil: 'domcontentloaded', timeout: tmo });
      // 给懒加载/字体一点时间，但不无限等（超时不致命，仍截当前画面）
      await page.waitForTimeout(1200).catch(() => {});
      writeFile(absOutPath, await page.screenshot({ fullPage: false }));
    } finally {
      try {
        await page.close();
      } catch {
        /* 忽略 */
      }
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: 'capture_failed', error: String(e?.message || e).slice(0, 300) };
  } finally {
    // CDP 连接不关（那是别人的服务）；仅关闭自己 launch 出来的浏览器
    if (browser && closeBrowser) {
      try {
        await browser.close();
      } catch {
        /* 忽略 */
      }
    }
  }
}

// ---------------------------------------------------------------- 编排

/**
 * 为单个链接创建快照：抓 HTML → 解析元数据 → 归档 HTML → 下载封面 → 尝试截图。
 * 任一步失败都不影响已拿到的部分（例如 HTML 存下了但封面 404）。
 * @returns 可直接入库的记录对象
 */
export async function createSnapshot(url, { archiveRoot, ts = Date.now() } = {}) {
  const paths = snapshotPaths(archiveRoot, url, ts);
  const rec = {
    url,
    finalUrl: url,
    title: '',
    description: '',
    siteName: '',
    domain: paths.htmlRel.split('/')[1] || '',
    htmlPath: '',
    coverPath: '',
    screenshotPath: '',
    status: 'ok',
    error: '',
    createdAt: ts,
  };

  let html = '';
  try {
    const page = await fetchPage(url);
    html = page.html;
    rec.finalUrl = page.finalUrl;
  } catch (e) {
    rec.status = 'fetch_failed';
    rec.error = String(e?.message || e).slice(0, 300);
    return rec;
  }

  // 1) 元数据 + HTML 归档（核心资产，先落盘）
  try {
    const meta = parseMetadata(html, rec.finalUrl);
    rec.title = meta.title;
    rec.description = meta.description;
    rec.siteName = meta.siteName;
    rec.domain = meta.domain || rec.domain;
  } catch {
    /* 元数据解析失败不致命，标题回退为域名 */
    rec.title = rec.domain;
  }
  try {
    writeFile(path.join(archiveRoot, paths.htmlRel), Buffer.from(html, 'utf8'));
    rec.htmlPath = paths.htmlRel;
  } catch (e) {
    rec.error = String(e?.message || e).slice(0, 300);
  }

  // 2) 封面图：og:image 优先，失败则回退 favicon
  for (const cand of [parseMetadata(html, rec.finalUrl).coverUrl, parseMetadata(html, rec.finalUrl).faviconUrl]) {
    if (!cand) continue;
    try {
      const img = await fetchImage(cand);
      if (!img.buffer.length) continue;
      const rel = `${paths.coverRel}.${img.ext}`;
      writeFile(path.join(archiveRoot, rel), img.buffer);
      rec.coverPath = rel;
      break;
    } catch {
      /* 换下一个候选 */
    }
  }

  // 3) 截图（best-effort）
  const shot = await captureScreenshot(rec.finalUrl, path.join(archiveRoot, paths.shotRel));
  if (shot.ok) rec.screenshotPath = paths.shotRel;
  else rec.screenshotError = shot.reason || 'unknown';

  return rec;
}
