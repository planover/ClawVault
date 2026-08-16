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
