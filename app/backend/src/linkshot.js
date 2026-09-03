import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import config from './config.js';
import { assertPublicUrl } from './ssrf.js';

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

// 带体积上限地读取响应体，避免恶意/异常大页面吃满内存
async function readCapped(res, maxBytes) {
  const reader = res.body?.getReader?.();
  if (!reader) {
    const ab = await res.arrayBuffer();
    return Buffer.from(ab.slice(0, maxBytes));
  }
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(Buffer.from(value));
      total += value.length;
      if (total >= maxBytes) {
        try {
          await reader.cancel();
        } catch {
          /* 忽略 */
        }
        break;
      }
    }
  } finally {
    try {
      reader.releaseLock?.();
    } catch {
      /* 忽略 */
    }
  }
  return Buffer.concat(chunks);
}

// 抓取网页。手动处理重定向以逐跳做 SSRF 校验——
// 这是链接预览类功能最容易被绕过的一环（公网域名 302 跳 127.0.0.1 / 169.254.169.254）。
export async function fetchPage(url, { timeoutMs, maxBytes, maxRedirects = 5 } = {}) {
  const tmo = timeoutMs ?? config.links?.timeoutMs ?? 15000;
  const cap = maxBytes ?? config.links?.maxBytes ?? 2 * 1024 * 1024;
  let current = url;
  for (let hop = 0; hop <= maxRedirects; hop++) {
    const safe = await assertPublicUrl(current); // 逐跳复检
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), tmo);
    try {
      const res = await fetch(safe.href, {
        redirect: 'manual',
        signal: ctrl.signal,
        headers: { 'user-agent': UA, accept: 'text/html,application/xhtml+xml,*/*;q=0.8' },
      });
      const loc = res.headers.get('location');
      if (res.status >= 300 && res.status < 400 && loc) {
        current = new URL(loc, safe.href).href;
        continue;
      }
      if (!res.ok) throw new Error(`网页返回 ${res.status}`);
      const buf = await readCapped(res, cap);
      return { html: buf.toString('utf8'), finalUrl: safe.href, status: res.status };
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error('重定向次数过多');
}

// 下载封面图（同样走 SSRF 校验 + 体积上限），返回 buffer 与扩展名
export async function fetchImage(url, { timeoutMs, maxBytes } = {}) {
  const tmo = timeoutMs ?? config.links?.timeoutMs ?? 15000;
  const cap = maxBytes ?? 2 * 1024 * 1024;
  const safe = await assertPublicUrl(url);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), tmo);
  try {
    const res = await fetch(safe.href, {
      redirect: 'manual',
      signal: ctrl.signal,
      headers: { 'user-agent': UA, accept: 'image/*' },
    });
    if (!res.ok) throw new Error(`图片返回 ${res.status}`);
    const buf = await readCapped(res, cap);
    const ct = String(res.headers.get('content-type') || '').toLowerCase();
    const ext = ct.includes('png')
      ? 'png'
      : ct.includes('gif')
        ? 'gif'
        : ct.includes('webp')
          ? 'webp'
          : 'jpg';
    return { buffer: buf, ext };
  } finally {
    clearTimeout(timer);
  }
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
  const exe = resolveChromium();
  if (!exe) return { ok: false, reason: 'no_browser' };
  const pw = await loadPlaywright();
  if (!pw) return { ok: false, reason: 'no_playwright' };

  const tmo = timeoutMs ?? config.links?.timeoutMs ?? 15000;
  let browser;
  try {
    // 快照只是一次性渲染，不需要持久化上下文；--no-sandbox 是容器内/非 root 运行的常见要求
    browser = await pw.chromium.launch({
      executablePath: exe,
      args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
    });
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: tmo });
    // 给懒加载/字体一点时间，但不无限等（超时不致命，仍截当前画面）
    await page.waitForTimeout(1200).catch(() => {});
    writeFile(absOutPath, await page.screenshot({ fullPage: false }));
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: 'capture_failed', error: String(e?.message || e).slice(0, 300) };
  } finally {
    try {
      await browser?.close();
    } catch {
      /* 忽略 */
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
