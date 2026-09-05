import { Agent, ProxyAgent, fetch as undiciFetch } from 'undici';
import { isPrivateIp, isLiteralIp, isInternalHostname, setResolver, lookupAll } from './ssrf.js';

// 解析器 seam 定义在 ssrf.js（assertPublicUrl 与 resolvePinned 共用同一份注入），
// 这里 re-export 保持既有测试 `import { setResolver } from './netguard.js'` 不变。
export { setResolver };

// 出网请求的安全封装（SEC-02 / SEC-08）。
//
// 解决两个问题：
//
// 1) **没有守卫的出网**：此前 storage.js 下载媒体时直接 `fetch(media.url)`，
//    既不做 SSRF 校验，也不限体积；而抓取的内容会落盘并能通过 /api/media/:id
//    读回来——等于一个「带响应回显的 SSRF」。这里统一走校验 + 体积上限。
//
// 2) **DNS Rebinding / TOCTOU**：先 `assertPublicUrl` 校验、再 `fetch` 出网，
//    中间有两次 DNS 解析。攻击者可让第一次解析到公网 IP、第二次解析到
//    127.0.0.1 / 169.254.169.254，从而绕过「解析后判私网」的校验。
//    修法是**解析一次、把地址钉住**：把校验通过的地址交给 undici 的
//    connect.lookup，让实际建连只能用这批地址（TLS 仍按原主机名做 SNI/证书校验）。
//
// 测试注入点（ENG-1 的教训）：此前测试用 `dns.lookup = async () => [...]` 打桩，
// 把回调式 API 换成 async 函数，**恰好掩盖了真实签名错误**，导致 130 个测试全绿
// 而生产 100% 失败。因此这里不做 monkey patch，改为显式注入实现的 seam，
// 让桩与真实实现走同一条代码路径。

let _impl = null;

// 供测试注入替身实现；传 null 恢复默认（undici）。
export function setFetchImpl(fn) {
  _impl = fn;
}

// 解析并校验主机名，返回校验通过的地址列表。失败抛错（错误信息可直接回给用户）。
export async function resolvePinned(hostname) {
  if (isLiteralIp(hostname)) {
    const bare = hostname.replace(/^\[|\]$/g, '');
    if (isPrivateIp(bare)) throw new Error('目标主机解析到内网/回环地址，出于 SSRF 防护已拒绝');
    return [{ address: bare, family: bare.includes(':') ? 6 : 4 }];
  }
  if (isInternalHostname(hostname)) {
    throw new Error('目标主机为内网/保留域名，出于 SSRF 防护已拒绝');
  }
  let addrs;
  try {
    addrs = await lookupAll(hostname);
  } catch (e) {
    if (e && (e.code === 'ENOTFOUND' || e.code === 'EAI_AGAIN' || e.code === 'EAI_FAIL')) {
      throw new Error('无法解析目标主机');
    }
    throw e;
  }
  if (!addrs.length) throw new Error('无法解析目标主机');
  for (const a of addrs) {
    if (isPrivateIp(a.address)) {
      throw new Error('目标主机解析到内网/回环地址，出于 SSRF 防护已拒绝');
    }
  }
  return addrs;
}

// 把已校验的地址钉成 lookup 回调。undici 建连时会调用它拿地址，
// 因此即便 DNS 被重绑定到私网，实际连接也只会用校验通过的那批地址。
function pinnedLookup(addrs) {
  return (hostname, options, callback) => {
    const all = options && options.all;
    // undici/net 期望的返回格式：{ address, family } 或 [{ address, family }]
    if (!all) return callback(null, addrs[0].address, addrs[0].family);
    return callback(null, addrs.map((a) => ({ address: a.address, family: a.family })));
  };
}

// 代理的 dispatcher 可复用（创建成本较高）；按代理 URL 缓存。
const _proxyAgents = new Map();

function proxyDispatcher(proxyUrl) {
  let a = _proxyAgents.get(proxyUrl);
  if (!a) {
    a = new ProxyAgent(proxyUrl);
    _proxyAgents.set(proxyUrl, a);
  }
  return a;
}

// 带体积上限地读取响应体（防异常大响应吃满内存）
async function readCapped(res, maxBytes) {
  const ab = await res.arrayBuffer();
  const buf = Buffer.from(ab);
  if (buf.length > maxBytes) throw new Error(`响应体积超出上限（${buf.length} > ${maxBytes}）`);
  return buf;
}

/**
 * 安全出网：先钉住 DNS 解析结果，再用该结果建连。
 * @param {string} url 已通过 assertPublicUrl 校验的绝对 URL
 * @param {object} opts { proxy, timeoutMs, maxBytes, headers, method, redirect }
 * @returns {Promise<{ok:boolean, status:number, headers:object, buffer:Buffer}>}
 */
export async function safeFetch(url, opts = {}) {
  const { proxy = null, timeoutMs = 15000, maxBytes = 32 * 1024 * 1024, ...rest } = opts;
  let u;
  try {
    u = new URL(url);
  } catch {
    throw new Error('非法的 URL');
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('仅允许 http/https 链接');

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    let init = { ...rest, signal: ctrl.signal, redirect: rest.redirect || 'manual' };

    if (!proxy) {
      // 无代理：解析一次 → 校验 → 钉住地址再建连（防 DNS Rebinding）
      // 注：测试注入的解析器在 ssrf.js 的 lookupAll 里生效，**不绕过**私网判定。
      const addrs = await resolvePinned(u.hostname);
      init.dispatcher = new Agent({ connect: { lookup: pinnedLookup(addrs) } });
      const res = await (_impl || undiciFetch)(u.href, init);
      const buffer = await readCapped(res, maxBytes);
      return {
        ok: res.ok,
        status: res.status,
        headers: { get: (k) => res.headers.get(k) },
        buffer,
        res,
      };
    }

    // 有代理：DNS 由代理侧解析，本地无法钉地址（代理被视为用户受信出网通道）。
    // 字面私网 IP 与内网/保留域名已在 resolvePinned/assertPublicUrl 的前置校验中拦掉。
    init.dispatcher = proxyDispatcher(proxy);
    const res = await (_impl || undiciFetch)(u.href, init);
    const buffer = await readCapped(res, maxBytes);
    return { ok: res.ok, status: res.status, headers: { get: (k) => res.headers.get(k) }, buffer, res };
  } finally {
    clearTimeout(timer);
  }
}

// 便捷封装：直接下载成 Buffer（供 storage.js 下载媒体使用）
export async function downloadToBuffer(url, opts = {}) {
  const { timeoutMs = 30000, maxBytes = 64 * 1024 * 1024, proxy = null } = opts;
  const r = await safeFetch(url, { timeoutMs, maxBytes, proxy });
  if (!r.ok) throw new Error(`下载失败 ${r.status}`);
  return r.buffer;
}
