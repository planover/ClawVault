// 凭据落盘加密：用 AES-256-GCM 加密整个 channels.json 内容，避免 token / secret 明文存储。
// 密钥优先级（取第一个可用）：
//   1) 环境变量 CLV_MASTER_KEY（推荐容器 / 生产，随 Secret 注入）
//   2) data_dir/.clvkey（首次运行自动生成，权限 600）
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const ALGO = 'aes-256-gcm';

// 把任意口令派生为稳定 32 字节密钥
export function deriveKey(passphrase) {
  return crypto.createHash('sha256').update(String(passphrase), 'utf8').update('clawvault').digest();
}

// 对象 → 加密字符串： <base64 iv>:<base64 tag>:<base64 ciphertext>
export function encryptJSON(obj, key) {
  const k = typeof key === 'string' ? deriveKey(key) : key;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGO, k, iv);
  const enc = Buffer.concat([cipher.update(JSON.stringify(obj), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv.toString('base64'), tag.toString('base64'), enc.toString('base64')].join(':');
}

// 加密字符串 → 对象（GCM 校验失败会抛错，可检测篡改）
export function decryptJSON(payload, key) {
  const k = typeof key === 'string' ? deriveKey(key) : key;
  const [ivB64, tagB64, encB64] = String(payload).split(':');
  if (!ivB64 || !tagB64 || !encB64) throw new Error('密文格式无效');
  const decipher = crypto.createDecipheriv(ALGO, k, Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  const dec = Buffer.concat([decipher.update(Buffer.from(encB64, 'base64')), decipher.final()]);
  return JSON.parse(dec.toString('utf8'));
}

// 取得或生成主密钥（32 字节 Buffer）。env 优先；否则用 data_dir/.clvkey。
export function loadKey(dataDir) {
  const envKey = process.env.CLV_MASTER_KEY;
  if (envKey && envKey.length) return deriveKey(envKey);
  const keyPath = path.join(dataDir, '.clvkey');
  try {
    return Buffer.from(fs.readFileSync(keyPath, 'utf8').trim(), 'hex');
  } catch {
    const k = crypto.randomBytes(32);
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(keyPath, k.toString('hex'), { mode: 0o600 });
    return k;
  }
}
