import crypto from 'node:crypto';

// iLink（微信 C2C）媒体解密工具
// 真机观察：图片/视频/文件地址藏在 item.<kind>_item.media.full_url，
// 内容为 AES-128-ECB 加密（密钥 = image_item.aeskey 的 16 字节 hex），
// 解密后得到标准 JPEG/PNG/MP4 等。本模块统一处理密钥归一化与解密。

// 将各种形态的 aesKey 归一化为 32 位 hex 字符串（AES-128 的 16 字节）。
// 支持：纯 hex（"0b98...9e"）、base64(hex)（media.aes_key 字段）、base64(16 原始字节)。
export function normalizeAesKey(k) {
  if (!k || typeof k !== 'string') return null;
  const s = k.trim();
  if (/^[0-9a-fA-F]{32}$/.test(s)) return s.toLowerCase();
  try {
    const b = Buffer.from(s, 'base64');
    if (b.length === 32 && /^[0-9a-fA-F]+$/.test(b.toString('ascii'))) {
      return b.toString('ascii').toLowerCase(); // base64 内是 hex 字符串
    }
    if (b.length === 16) return b.toString('hex'); // base64 内是原始 16 字节
  } catch {
    /* 非 base64，忽略 */
  }
  return null;
}

// AES-128-ECB 解密；自动去除末尾 PKCS7 填充（微信 C2C 媒体每块补齐 16 字节）。
export function decryptIlink(buf, aesKeyHex) {
  const key = Buffer.from(aesKeyHex, 'hex');
  if (key.length !== 16) throw new Error('aesKey 必须为 16 字节（32 位 hex）');
  const decipher = crypto.createDecipheriv('aes-128-ecb', key, null);
  decipher.setAutoPadding(false); // 由我们自己剥离填充，避免 final() 对异常长度抛错
  let pt = Buffer.concat([decipher.update(buf), decipher.final()]);
  if (pt.length) {
    const p = pt[pt.length - 1];
    if (p >= 1 && p <= 16 && pt.slice(pt.length - p).every((b) => b === p)) {
      pt = pt.slice(0, pt.length - p);
    }
  }
  return pt;
}

// 按文件头魔数判定真实扩展名（解密后扩展名可能与 URL 不符）。
export function detectMediaExt(buf) {
  if (!buf || buf.length < 4) return '';
  const h = buf.subarray(0, 12);
  if (h[0] === 0xff && h[1] === 0xd8 && h[2] === 0xff) return 'jpg';
  if (h[0] === 0x89 && h[1] === 0x50 && h[2] === 0x4e && h[3] === 0x47) return 'png';
  if (h[0] === 0x47 && h[1] === 0x49 && h[2] === 0x46 && h[3] === 0x38) return 'gif';
  if (h[0] === 0x52 && h[1] === 0x49 && h[2] === 0x46 && h[3] === 0x46 && h[8] === 0x57 && h[9] === 0x45 && h[10] === 0x42 && h[11] === 0x50) return 'webp';
  if (h[0] === 0x25 && h[1] === 0x50 && h[2] === 0x44 && h[3] === 0x46) return 'pdf';
  if (h[0] === 0x1a && h[1] === 0x45 && h[2] === 0xdf && h[3] === 0xa3) return 'webm';
  if (h[4] === 0x66 && h[5] === 0x74 && h[6] === 0x79 && h[7] === 0x70) return 'mp4'; // ftyp
  if (h[0] === 0x4f && h[1] === 0x67 && h[2] === 0x67 && h[3] === 0x53) return 'ogg';
  // 音频（语音/音乐）
  if (h[0] === 0x23 && h[1] === 0x21 && h[2] === 0x41 && h[3] === 0x4d && h[4] === 0x52) return 'amr'; // #!AMR
  if (h[0] === 0x52 && h[1] === 0x49 && h[2] === 0x46 && h[3] === 0x46 && h[8] === 0x57 && h[9] === 0x41 && h[10] === 0x56 && h[11] === 0x45) return 'wav'; // RIFF....WAVE
  if (h[0] === 0x66 && h[1] === 0x4c && h[2] === 0x61 && h[3] === 0x43) return 'flac'; // fLaC
  if (h[0] === 0x49 && h[1] === 0x44 && h[2] === 0x33) return 'mp3'; // ID3
  if ((h[0] & 0xff) === 0xff && (h[1] & 0xe0) === 0xe0) return 'mp3'; // MP3 帧
  if (h[0] === 0x50 && h[1] === 0x4b && h[2] === 0x03 && h[3] === 0x04) return 'zip'; // docx/xlsx/zip
  if (h[0] === 0x3c && h[1] === 0x3f && h[2] === 0x78 && h[3] === 0x6d) return 'xml';
  return '';
}
