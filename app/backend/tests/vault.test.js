import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { encryptJSON, decryptJSON, deriveKey, loadKey } from '../src/vault.js';
import { ChannelManager } from '../src/manager.js';

const KEY = 'test-master-passphrase';

test('vault: 加解密往返（口令字符串）', () => {
  const obj = { a: 1, b: 'secret', c: [1, 2, 3] };
  const enc = encryptJSON(obj, KEY);
  assert.notEqual(enc, JSON.stringify(obj));
  assert.deepEqual(decryptJSON(enc, KEY), obj);
});

test('vault: 加解密往返（32 字节 Buffer 密钥）', () => {
  const k = deriveKey('another-pass');
  const obj = { token: 'ghp_xxx', secret: 's' };
  const enc = encryptJSON(obj, k);
  assert.deepEqual(decryptJSON(enc, k), obj);
});

test('vault: 密文被篡改 → GCM 校验失败抛错', () => {
  const enc = encryptJSON({ x: 1 }, KEY);
  const [iv, tag, ct] = enc.split(':');
  const tampered = [iv, tag, Buffer.from(ct, 'base64').reverse().toString('base64')].join(':');
  assert.throws(() => decryptJSON(tampered, KEY));
});

test('vault: 格式非法抛错', () => {
  assert.throws(() => decryptJSON('not-valid', KEY));
});

test('vault: loadKey 优先使用 CLV_MASTER_KEY 环境变量', () => {
  const prev = process.env.CLV_MASTER_KEY;
  try {
    process.env.CLV_MASTER_KEY = 'env-secret-key';
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fnclaw-key-'));
    const k1 = loadKey(dir);
    const k2 = loadKey(dir);
    assert.ok(Buffer.isBuffer(k1));
    assert.equal(k1.toString('hex'), k2.toString('hex'));
    // 不应落盘 .clvkey（env 优先）
    assert.equal(fs.existsSync(path.join(dir, '.clvkey')), false);
    fs.rmSync(dir, { recursive: true, force: true });
  } finally {
    if (prev === undefined) delete process.env.CLV_MASTER_KEY;
    else process.env.CLV_MASTER_KEY = prev;
  }
});

test('vault: loadKey 无 env 时自动生成 .clvkey 并复用', () => {
  const prev = process.env.CLV_MASTER_KEY;
  delete process.env.CLV_MASTER_KEY;
  try {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fnclaw-key-'));
    const k1 = loadKey(dir);
    assert.ok(fs.existsSync(path.join(dir, '.clvkey')));
    const k2 = loadKey(dir);
    assert.equal(k1.toString('hex'), k2.toString('hex'), '同一目录应复用同一密钥');
    fs.rmSync(dir, { recursive: true, force: true });
  } finally {
    if (prev !== undefined) process.env.CLV_MASTER_KEY = prev;
  }
});

test('manager: channels.json 落盘为密文，且可还原明文凭据', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fnclaw-mgr-'));
  const TOKEN = 'sk-filedrop-secret-12345';
  try {
    // 第一个实例：创建含 password 字段（send_token）的 webhook 通道并持久化
    const m1 = new ChannelManager({ dataDir: dir, onMessage: async () => {}, onStatus: () => {} });
    m1.createChannel({ name: '投递通道', providerType: 'webhook', providerConfig: { send_url: 'https://example.com', send_token: TOKEN } });
    const raw = fs.readFileSync(path.join(dir, 'channels.json'), 'utf8');
    assert.doesNotMatch(raw, /sk-filedrop-secret-12345/, '磁盘上不应出现明文 token');
    assert.match(raw, /^[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$/, '应为 iv:tag:ciphertext 密文');

    // 第二个实例：重新从磁盘加载，凭据应完整还原
    const m2 = new ChannelManager({ dataDir: dir, onMessage: async () => {}, onStatus: () => {} });
    const reloaded = [...m2.channels.values()][0];
    assert.ok(reloaded, '应成功加载通道');
    assert.equal(reloaded.providerConfig.send_token, TOKEN, 'token 应被解密还原');

    // 列表接口对 password 字段脱敏
    const list = m2.listChannels();
    const cfg = list[0].config;
    assert.equal(cfg.send_token, '••••••••');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('manager: 兼容旧明文 channels.json 并迁移为加密', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fnclaw-mgr-'));
  try {
    const legacy = [{ id: 'c1', name: '旧通道', providerType: 'webhook', providerConfig: { send_url: 'https://x' }, loggedIn: false, needRescan: false }];
    fs.writeFileSync(path.join(dir, 'channels.json'), JSON.stringify(legacy));
    // 构造时触发迁移：读取明文 → 重写为加密
    new ChannelManager({ dataDir: dir, onMessage: async () => {}, onStatus: () => {} });
    const raw = fs.readFileSync(path.join(dir, 'channels.json'), 'utf8');
    assert.doesNotMatch(raw, /^\[/, '迁移后应为密文，不再是 JSON 数组');
    assert.match(raw, /^[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
