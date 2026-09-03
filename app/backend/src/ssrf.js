import dns from 'node:dns';

// SSRF 防护公共模块。
//
// 背景：ClawVault 会在两处向外发起请求——
//   1) AI 分类/连接的 baseUrl（classify.js 的 assertSafeTarget，带"已保存默认配置"豁免）；
//   2) 消息里出现的外部链接（linkshot.js 抓网页做快照，无豁免）。
// 两者的内核都是「DNS 解析后拒绝私网/回环/链路本地」，故抽到本模块共用，
// 避免两处规则漂移。

// 判断 IP 是否为私网 / 回环 / 链路本地 / 保留地址
export function isPrivateIp(ip) {
  if (typeof ip !== 'string') return true;
  if (ip.includes('.')) {
    const p = ip.split('.').map(Number);
    if (p.length !== 4 || p.some((n) => Number.isNaN(n) || n < 0 || n > 255)) return true;
    const [a, b] = p;
    if (a === 0) return true; // 0.0.0.0/8
    if (a === 10) return true; // 10/8
    if (a === 127) return true; // loopback
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64/10
    if (a === 169 && b === 254) return true; // 链路本地 / 云元数据 169.254.169.254
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16/12
    if (a === 192 && b === 168) return true; // 192.168/16
    if (a === 198 && (b === 18 || b === 19)) return true; // 198.18/15
    if (a >= 224) return true; // 组播 / 保留 / 受限广播
    return false;
  }
  const v = ip.toLowerCase();
  if (v === '::1' || v === '::' || v === '::ffff:0:0') return true;
  if (v.startsWith('fe80')) return true; // 链路本地
  if (v.startsWith('fc') || v.startsWith('fd')) return true; // 唯一本地地址 ULA
  if (v.startsWith('::ffff:')) return isPrivateIp(v.slice(7)); // IPv4 映射
  return false;
}

// 是否为字面 IP（无需 DNS 即可判定私网，覆盖 127.0.0.1 / ::1 / 169.254.169.254 等）
export function isLiteralIp(host) {
  if (!host) return false;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return true; // IPv4
  if (host.startsWith('[') && host.endsWith(']')) return true; // [IPv6]
  return false;
}

// 已知内网 / 保留域名：无需 DNS 即可拦截（主要用于「走代理出网」场景——
// 沙箱内本地无法解析目标主机，必须由这里兜底，否则代理会被用于访问内网 / 云元数据）。
export function isInternalHostname(hostname) {
  const h = String(hostname).toLowerCase().replace(/\.+$/, '');
  if (h === 'localhost' || h === 'localhost.localdomain') return true;
  if (h === '0.0.0.0' || h === '::' || h === '[::]') return true;
  // .local/.internal/.lan/.home.arpa/.corp/.intranet 通常只在局域网内解析为私网地址
  if (/\.(local|internal|lan|home\.arpa|corp|intranet)$/.test(h)) return true;
  // 云元数据等高危目标（metadata / metadata.google.internal / *.metadata.*）
  if (/^metadata(\.|$)/.test(h)) return true;
  return false;
}

// 校验一个「外部链接」不会解析到内网 / 回环地址。用于抓取用户消息里的网址。
//
// 关键：重定向必须逐跳调用本函数。
// 否则「公网域名 → 302 跳 127.0.0.1 / 169.254.169.254」可绕过首跳校验，
// 这是链接预览类功能最经典的 SSRF 绕过姿势。
//
// proxy 参数：当链接抓取经由代理出网时传入代理地址。
//   fnOS 应用沙箱本地无出站 DNS，必须由代理侧解析主机名；此时本地 dns.lookup 会失败，
//   故跳过「本地 DNS → 私网 IP」这一环。但显式内网 IP 与内网/保留域名已在上面两道
//   校验里拦截（无需 DNS），云元数据 169.254.169.254 属字面 IP 同样被拦——
//   因此即便走代理，SSRF 最高危的几条路径仍被封死，代理本身视为用户受信出网通道。
export async function assertPublicUrl(rawUrl, { proxy = null } = {}) {
  let u;
  try {
    u = new URL(rawUrl);
  } catch {
    throw new Error('非法的 URL');
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('仅允许 http/https 链接');
  if (u.username || u.password) throw new Error('含用户名密码的链接不受支持');

  // 1) 字面 IP：无需 DNS 直接判私网（127.0.0.1 / ::1 / 169.254.169.254 云元数据 等）
  if (isLiteralIp(u.hostname) && isPrivateIp(u.hostname)) {
    throw new Error('目标主机解析到内网/回环地址，出于 SSRF 防护已拒绝');
  }
  // 2) 已知内网 / 保留域名：无需 DNS（尤其走代理出网时必须兜底拦截）
  if (isInternalHostname(u.hostname)) {
    throw new Error('目标主机为内网/保留域名，出于 SSRF 防护已拒绝');
  }

  // 3) 走代理出网：本地不做 DNS 解析，跳过私网 IP 校验（由代理侧解析，受信出网）
  if (proxy) return u;

  // 4) 直连：本地 DNS 解析 + 私网 IP 校验
  let addrs;
  try {
    addrs = await dns.lookup(u.hostname, { all: true });
  } catch {
    throw new Error('无法解析目标主机');
  }
  for (const a of addrs) {
    if (isPrivateIp(a.address)) {
      throw new Error('目标主机解析到内网/回环地址，出于 SSRF 防护已拒绝');
    }
  }
  return u;
}
