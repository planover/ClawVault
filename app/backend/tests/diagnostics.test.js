import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Storage } from '../src/storage.js';
import createVoiceRouter from '../src/routes/voice.js';
import createMediaRouter from '../src/routes/media.js';
import createHealthRouter from '../src/routes/health.js';
import config from '../src/config.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fnclaw-diag-'));
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

test('GET /api/health 返回运行状况 JSON（含版本/统计/通道/AI失败）', async () => {
  const manager = {
    listChannels: () => [{ id: 'c1', name: '通道1', providerType: 'wechat_ilink', connected: true, needRescan: false }],
  };
  const app = express();
  app.use('/api/health', createHealthRouter({ storage, manager, config, startedAt: Date.now() - 9000 }));
  const server = await startServer(app);
  try {
    const res = await fetch(base(server) + '/api/health');
    assert.equal(res.status, 200);
    const j = await res.json();
    assert.equal(j.ok, true);
    assert.ok(typeof j.app.version === 'string' || j.app.version === null);
    assert.ok(j.app.uptimeSec >= 0);
    assert.ok(typeof j.database.total === 'number');
    assert.ok(typeof j.database.byKind === 'object');
    assert.ok(Array.isArray(j.ai.recentFailures));
    assert.ok('consistent' in j.versionConsistency);
    assert.equal(j.channels.total, 1);
    assert.equal(j.channels.connected, 1);
    // simple 模式
    const sres = await fetch(base(server) + '/api/health?simple=1');
    const s = await sres.json();
    assert.equal(s.ok, true);
    assert.ok('mediaGaps' in s);
  } finally {
    server.close();
  }
});

test('语音路由：路径穿越返回 403', async () => {
  const rec = storage.saveMessage({ channelId: 'c', channelName: '通道V', peer: 'u', text: 'x', kind: 'voice', category: '语音', voice: '../../../etc/passwd' });
  const app = express();
  app.use('/api/voice', createVoiceRouter({ storage }));
  const server = await startServer(app);
  try {
    const res = await fetch(base(server) + `/api/voice/${rec.id}`);
    assert.equal(res.status, 403, '越界路径必须拒绝');
  } finally {
    server.close();
  }
});

test('语音路由：正常音频返回 200 且内容正确', async () => {
  const rel = await storage.saveVoiceFile({ channelName: '通道V', media: { buffer: Buffer.from('AUDIO123'), ext: 'mp3' } });
  const rec = storage.saveMessage({ channelId: 'c', channelName: '通道V', peer: 'u', text: 'x', kind: 'voice', category: '语音', voice: rel });
  const app = express();
  app.use('/api/voice', createVoiceRouter({ storage }));
  const server = await startServer(app);
  try {
    const res = await fetch(base(server) + `/api/voice/${rec.id}`);
    assert.equal(res.status, 200);
    assert.equal(await res.text(), 'AUDIO123');
  } finally {
    server.close();
  }
});

test('媒体路由：正常媒体返回 200，路径穿越返回 403，缺失返回 404', async () => {
  const rel = await storage.saveMedia({ channelName: '通道M', id: 999, media: { buffer: Buffer.from('IMAGEX'), ext: 'png' } });
  const rec = storage.saveMessage({ channelId: 'c', channelName: '通道M', peer: 'u', text: '图', kind: 'image', category: '图片', media: rel });
  const app = express();
  app.use('/api/media', createMediaRouter({ storage }));
  const server = await startServer(app);
  try {
    let res = await fetch(base(server) + `/api/media/${rec.id}`);
    assert.equal(res.status, 200);
    assert.equal(await res.text(), 'IMAGEX');

    // 路径穿越
    const bad = storage.saveMessage({ channelId: 'c', channelName: '通道M', peer: 'u', text: 'x', kind: 'image', category: '图片', media: '../../../etc/passwd' });
    res = await fetch(base(server) + `/api/media/${bad.id}`);
    assert.equal(res.status, 403);

    // 缺失（无 media）
    const none = storage.saveMessage({ channelId: 'c', channelName: '通道M', peer: 'u', text: 'x', kind: 'image', category: '图片' });
    res = await fetch(base(server) + `/api/media/${none.id}`);
    assert.equal(res.status, 404);
  } finally {
    server.close();
  }
});
