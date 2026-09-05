import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Storage } from '../src/storage.js';
import createAboutRouter from '../src/routes/about.js';
import createChannelsRouter from '../src/routes/channels.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fnclaw-routes-'));
const archiveRoot = path.join(tmp, 'archive');
const dataDir = path.join(tmp, 'data');
const storage = new Storage({ dataDir, archiveRoot });

function startServer(app) {
  return new Promise((resolve) => {
    const server = http.createServer(app);
    server.listen(0, () => resolve(server));
  });
}
const base = (server) => `http://127.0.0.1:${server.address().port}`;

test('GET /api/about 返回版本与仓库信息（ClawVault 真实身份）', async () => {
  const app = express();
  app.use('/api/about', createAboutRouter());
  const server = await startServer(app);
  try {
    const res = await fetch(base(server) + '/api/about');
    assert.equal(res.status, 200);
    const j = await res.json();
    assert.equal(j.name, '爪匣 ClawVault');
    assert.equal(j.license, 'AGPL-3.0');
    assert.equal(j.developer, 'planover');
    assert.match(j.repo, /github\.com\/planover\/ClawVault/);
    assert.ok(j.version, '版本号应非空（读取 manifest）');
  } finally {
    server.close();
  }
});

test('PUT /api/channels/:id 重命名通道并同步存储', async () => {
  const channels = new Map();
  const manager = {
    getChannel: (id) => channels.get(id),
    listChannels: () => [...channels.values()],
    renameChannel: (id, name) => {
      const c = channels.get(id);
      if (!c) throw new Error('通道不存在');
      c.name = name;
    },
  };
  channels.set('c9', { id: 'c9', name: '旧名' });
  const app = express();
  app.use(express.json());
  app.use('/api/channels', createChannelsRouter({ manager, storage }));
  const server = await startServer(app);
  try {
    const res = await fetch(base(server) + '/api/channels/c9', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: '新名' }),
    });
    assert.equal(res.status, 200);
    assert.equal(channels.get('c9').name, '新名');
    const bad = await fetch(base(server) + '/api/channels/c9', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: '  ' }),
    });
    assert.equal(bad.status, 400);
    const missing = await fetch(base(server) + '/api/channels/nope', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'x' }),
    });
    assert.equal(missing.status, 404);
  } finally {
    server.close();
  }
});

// SEC-15：/api/health 对网关身份豁免（fnOS 探针用），因此生产态（gatewayPrefix 已配）
// 下未认证请求只应拿到最小存活信息；内部拓扑（归档路径/AI baseUrl/通道列表）只对
// 带网关注入身份的调用方开放。双向覆盖：既测脱敏也测放行。
test('GET /api/health 生产态未认证仅回最小存活信息（SEC-15）', async () => {
  const { default: createHealthRouter } = await import('../src/routes/health.js');
  const manager = { listChannels: () => [] };
  const config = { gatewayPrefix: '/app/clawvault', ai: {}, classification: {} };
  const app = express();
  app.use('/api/health', createHealthRouter({ storage, manager, config, startedAt: Date.now() }));
  const server = await startServer(app);
  try {
    const res = await fetch(base(server) + '/api/health');
    assert.equal(res.status, 200);
    const j = await res.json();
    assert.equal(j.ok, true);
    assert.equal(j.system, undefined, '未认证不应看到系统信息');
    assert.equal(j.ai, undefined, '未认证不应看到 AI 配置');
    assert.equal(j.channels, undefined, '未认证不应看到通道列表');
  } finally {
    server.close();
  }
});

test('GET /api/health 带网关身份返回完整信息（SEC-15 放行向）', async () => {
  const { default: createHealthRouter } = await import('../src/routes/health.js');
  const manager = { listChannels: () => [] };
  const config = { gatewayPrefix: '/app/clawvault', ai: {}, classification: {} };
  const app = express();
  app.use((req, res, next) => {
    req.fnUser = { uid: '1', username: 'admin', isAdmin: true };
    next();
  });
  app.use('/api/health', createHealthRouter({ storage, manager, config, startedAt: Date.now() }));
  const server = await startServer(app);
  try {
    const res = await fetch(base(server) + '/api/health');
    assert.equal(res.status, 200);
    const j = await res.json();
    assert.equal(j.ok, true);
    assert.ok(j.system && j.app, '已认证应看到完整负载');
  } finally {
    server.close();
  }
});

// SEC-04：入站 Webhook 签名校验。配置 secret 的通道必须携带令牌或 HMAC 签名，
// 否则 401；验签必须基于原始请求体字节。
test('POST /api/inbound 配置 secret 后强制验签（SEC-04，双向覆盖）', async () => {
  const crypto = await import('node:crypto');
  const secret = 'topsecret';
  const body = JSON.stringify({ text: '你好', peer: 'u1' });
  const sig = 'sha256=' + crypto.createHmac('sha256', secret).update(Buffer.from(body)).digest('hex');

  // 复刻 index.js 的入站守卫逻辑（manager 用桩，避免启动整个服务）
  const manager = {
    inboundSecret: (id) => (id === 'ch1' ? secret : null),
    inbound: async () => ({ ok: true }),
  };
  const app = express();
  app.use(
    express.json({
      verify: (req, res, buf) => {
        req.rawBody = buf;
      },
    }),
  );
  function eq(a, b) {
    const ba = Buffer.from(String(a));
    const bb = Buffer.from(String(b));
    return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
  }
  app.post('/api/inbound/:id', async (req, res) => {
    const s = manager.inboundSecret(req.params.id);
    if (s === null) return res.status(404).json({ error: '通道不存在' });
    const token = req.headers['x-clawvault-token'];
    const sigH = req.headers['x-clawvault-signature'];
    const expect = 'sha256=' + crypto.createHmac('sha256', s).update(req.rawBody || Buffer.alloc(0)).digest('hex');
    if (!((token && eq(token, s)) || (sigH && eq(sigH, expect)))) {
      return res.status(401).json({ error: '入站签名校验失败' });
    }
    res.json(await manager.inbound(req.params.id, req.body, req.headers));
  });
  const server = await startServer(app);
  try {
    // 无凭据 → 401
    const noAuth = await fetch(base(server) + '/api/inbound/ch1', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    });
    assert.equal(noAuth.status, 401);
    // 错误令牌 → 401
    const badToken = await fetch(base(server) + '/api/inbound/ch1', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-clawvault-token': 'wrong' },
      body,
    });
    assert.equal(badToken.status, 401);
    // 共享令牌 → 放行
    const okToken = await fetch(base(server) + '/api/inbound/ch1', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-clawvault-token': secret },
      body,
    });
    assert.equal(okToken.status, 200);
    // HMAC 签名 → 放行
    const okSig = await fetch(base(server) + '/api/inbound/ch1', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-clawvault-signature': sig },
      body,
    });
    assert.equal(okSig.status, 200);
    // 篡改签名 → 401
    const badSig = await fetch(base(server) + '/api/inbound/ch1', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-clawvault-signature': sig.replace(/.$/, '0') },
      body,
    });
    assert.equal(badSig.status, 401);
  } finally {
    server.close();
  }
});
