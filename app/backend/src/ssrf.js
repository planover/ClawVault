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

// 校验一个「外部链接」不会解析到内网 / 回环地址。用于抓取用户消息里的网址。
//
// 关键：重定向必须逐跳调用本函数。
// 否则「公网域名 → 302 跳 127.0.0.1 / 169.254.169.254」可绕过首跳校验，
// 这是链接预览类功能最经典的 SSRF 绕过姿势。
export async function assertPublicUrl(rawUrl) {
  let u;
  try {
    u = new URL(rawUrl);
  } catch {
    throw new Error('非法的 URL');
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('仅允许 http/https 链接');
  if (u.username || u.password) throw new Error('含用户名密码的链接不受支持');

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
