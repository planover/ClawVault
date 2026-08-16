import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { normalizeAesKey, decryptIlink, detectMediaExt } from '../src/ilink_crypto.js';
import { extractMedia } from '../src/providers/wechat_ilink.js';
import { Storage } from '../src/storage.js';

const HEX_KEY = '0b98ff7ff23724e3f530d028e3280b9e';

// 用与 iLink 一致的 AES-128-ECB + PKCS7 加密一段明文（仅用于测试解密可逆）
function encryptEcb(buf, keyHex) {
  const key = Buffer.from(keyHex, 'hex');
  const c = crypto.createCipheriv('aes-128-ecb', key, null);
  c.setAutoPadding(true);
  return Buffer.concat([c.update(buf), c.final()]);
}

test('normalizeAesKey: 各形态归一化为 32 位 hex', () => {
  assert.equal(normalizeAesKey(HEX_KEY), HEX_KEY); // 纯 hex
  assert.equal(normalizeAesKey('MGI5OGZmN2ZmMjM3MjRlM2Y1MzBkMDI4ZTMyODBiOWU='), HEX_KEY); // base64(hex)
  assert.equal(normalizeAesKey(Buffer.from(HEX_KEY, 'hex').toString('base64')), HEX_KEY); // base64(16 原始字节)
  assert.equal(normalizeAesKey('not-a-key'), null);
  assert.equal(normalizeAesKey(null), null);
});

test('decryptIlink: AES-128-ECB 解密可逆并去除 PKCS7', () => {
  const plain = Buffer.from('89504e470d0a1a0a' + 'ab'.repeat(200), 'hex'); // 以 PNG 头开头便于类型判定
  const enc = encryptEcb(plain, HEX_KEY);
  assert.notDeepEqual(enc, plain);
  const dec = decryptIlink(enc, HEX_KEY);
  assert.deepEqual(dec, plain);
});

test('detectMediaExt: 按文件头魔数判定', () => {
  assert.equal(detectMediaExt(Buffer.from([0xff, 0xd8, 0xff, 0x00])), 'jpg');
  assert.equal(detectMediaExt(Buffer.from([0x89, 0x50, 0x4e, 0x47])), 'png');
  assert.equal(detectMediaExt(Buffer.from([0x47, 0x49, 0x46, 0x38])), 'gif');
  assert.equal(detectMediaExt(Buffer.from('RIFFxxxxWEBP', 'ascii')), 'webp');
  assert.equal(detectMediaExt(Buffer.from([0x25, 0x50, 0x44, 0x46])), 'pdf');
  assert.equal(detectMediaExt(Buffer.from('xxxxftyp', 'ascii')), 'mp4');
  assert.equal(detectMediaExt(Buffer.from([0x00, 0x01, 0x02])), '');
});

test('extractMedia: iLink 真机 image_item 提取 media.full_url 与 aesKey', () => {
  const msg = {
    item_list: [{
      image_item: {
        aeskey: HEX_KEY,
        media: { full_url: 'https://novac2c.cdn.weixin.qq.com/c2c/download?encrypted_query_param=XXX&taskid=abc', aes_key: 'MGI5OGZmN2ZmMjM3MjRlM2Y1MzBkMDI4ZTMyODBiOWU=' },
        mid_size: 152331,
      },
    }],
  };
  const m = extractMedia(msg, 'image');
  assert.ok(m);
  assert.equal(m.url, 'https://novac2c.cdn.weixin.qq.com/c2c/download?encrypted_query_param=XXX&taskid=abc');
  assert.equal(m.aesKey, HEX_KEY);
});

test('extractMedia: 无加密密钥的普通图片只返回 url', () => {
  const msg = { item_list: [{ image_item: { image_url: 'https://x.com/a.png' } }] };
  const m = extractMedia(msg, 'image');
  assert.ok(m);
  assert.equal(m.url, 'https://x.com/a.png');
  assert.equal(m.aesKey, null);
});

test('extractMedia: 无可用地址返回 null', () => {
  const msg = { item_list: [{ text_item: { text: 'hi' } }] };
  assert.equal(extractMedia(msg, 'image'), null);
});

test('saveMedia: 带 aesKey 时解密落盘为真实类型文件', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fnclaw-aes-'));
  const storage = new Storage({ dataDir: path.join(tmp, 'data'), archiveRoot: path.join(tmp, 'archive') });
  const plain = Buffer.from('89504e470d0a1a0a' + 'cd'.repeat(300), 'hex'); // 伪 PNG
  const enc = encryptEcb(plain, HEX_KEY);
  const rel = await storage.saveMedia({ channelName: '通道甲', id: 1, media: { buffer: enc, aesKey: HEX_KEY } });
  assert.ok(rel, '应返回相对路径');
  assert.ok(rel.endsWith('.png'), `扩展名应判定为 png，实际: ${rel}`);
  const abs = path.join(storage.archiveRoot, rel);
  assert.deepEqual(fs.readFileSync(abs), plain, '落盘内容应等于解密后的明文');
});
