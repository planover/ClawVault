import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import AdmZip from 'adm-zip';
import { Storage } from '../src/storage.js';
import createBackupRouter from '../src/routes/backup.js';
import createSettingsRouter from '../src/routes/settings.js';

// FUN-4（整库备份导出）与 FUN-3（CDP 端点设置项）回归测试。
// 安全断言双向覆盖：非管理员必须被拒（403），管理员必须放行且 zip 内容完整。

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'clv-backup-'));
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

const allow = (req, res, next) => next();
const deny = (req, res) => res.status(403).json({ ok: false, error: '需要管理员权限' });

test('FUN-4：非管理员导出备份被拒（403）', async () => {
  const app = express();
  app.use('/api/backup', createBackupRouter({ config: { dataDir }, storage, requireAdmin: deny }));
  const server = await startServer(app);
  try {
    const res = await fetch(base(server) + '/api/backup/export');
    assert.equal(res.status, 403);
  } finally {
    server.close();
  }
});

test('FUN-4：管理员导出 zip，含一致性 db 快照 + 配置 + 主密钥 + manifest', async () => {
  // 造数据：一条消息 + 设置/渠道/主密钥文件
  storage.saveMessage({ channelId: 'c1', channelName: '测试', peer: '张三', text: '备份我' });
  fs.writeFileSync(path.join(dataDir, 'settings.json'), JSON.stringify({ settingsVersion: 1 }));
  fs.writeFileSync(path.join(dataDir, 'channels.json'), JSON.stringify([]));
  fs.writeFileSync(path.join(dataDir, '.clvkey'), 'test-master-key', { mode: 0o600 });

  const app = express();
  app.use('/api/backup', createBackupRouter({ config: { dataDir }, storage, requireAdmin: allow }));
  const server = await startServer(app);
  try {
    const res = await fetch(base(server) + '/api/backup/export');
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') || '', /application\/zip/);
    assert.match(res.headers.get('content-disposition') || '', /clawvault-backup-.*\.zip/);

    const zip = new AdmZip(Buffer.from(await res.arrayBuffer()));
    const names = zip.getEntries().map((e) => e.entryName);
    assert.ok(names.includes('archive.db'), 'zip 应含 archive.db');
    assert.ok(names.includes('settings.json'), 'zip 应含 settings.json');
    assert.ok(names.includes('channels.json'), 'zip 应含 channels.json');
    assert.ok(names.includes('.clvkey'), 'zip 应含 .clvkey（完整可恢复所需）');
    assert.ok(names.includes('manifest.json'), 'zip 应含 manifest.json');

    const manifest = JSON.parse(zip.readAsText('manifest.json'));
    assert.equal(manifest.app, 'clawvault');
    assert.ok(manifest.warning.includes('主密钥'), 'manifest 应明示密钥敏感性');

    // 快照本身是一个可打开的完整 SQLite 库（WAL 内容已合并）
    const snapPath = path.join(tmp, 'restore-check.db');
    fs.writeFileSync(snapPath, zip.getEntry('archive.db').getData());
    const Database = (await import('better-sqlite3')).default;
    const db = new Database(snapPath, { readonly: true });
    const row = db.prepare("SELECT text FROM messages WHERE text = '备份我'").get();
    db.close();
    assert.equal(row?.text, '备份我', '导出的 db 快照应含最新写入（WAL 已合并）');
  } finally {
    server.close();
  }
});

test('FUN-3：设置 GET 返回 links.cdpEndpoint；POST 白名单更新并持久化', async () => {
  const config = {
    ai: { apiKey: '', baseUrl: 'https://x', model: 'm' },
    ingest: {},
    classification: {},
    archiveRoot: '/x',
    demoMode: false,
    links: { cdpEndpoint: '', timeoutMs: 15000 },
  };
  let saved = null;
  const app = express();
  app.use(express.json());
  app.use(
    '/api/settings',
    createSettingsRouter({ config, storage, saveSettings: () => (saved = JSON.parse(JSON.stringify({ links: config.links }))) }),
  );
  const server = await startServer(app);
  try {
    const g = await (await fetch(base(server) + '/api/settings')).json();
    assert.equal(g.links.cdpEndpoint, '');

    const res = await fetch(base(server) + '/api/settings', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ links: { cdpEndpoint: '  http://nas:3000  ', timeoutMs: 1 } }),
    });
    assert.equal(res.status, 200);
    // 白名单：仅 cdpEndpoint 生效，timeoutMs 等运行时字段不允许被覆盖
    assert.equal(config.links.cdpEndpoint, 'http://nas:3000', '应 trim 后保存');
    assert.equal(config.links.timeoutMs, 15000, '非白名单字段不得被覆盖');
    assert.equal(saved.links.cdpEndpoint, 'http://nas:3000', '应触发持久化');
  } finally {
    server.close();
  }
});
