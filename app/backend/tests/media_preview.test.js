import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import AdmZip from 'adm-zip';
import tar from 'tar';
import createMediaRouter from '../src/routes/media.js';

// 文件预览相关路由的回归测试：
//   /api/media/list/:id    → 压缩包内文件列表（zip / tgz）
//   /api/media/preview/:id → Office 文档（docx）转 HTML
//   /api/media/:id?inline=1 → 内联预览（PDF iframe 依赖 inline 处置）
//
// 这里用最小假 Storage 而不是真实 Storage，原因有二：
//   1) 本测试只验证媒体路由（路径解析/MIME/处置/预览转换），与存储层无关，
//      用假对象能让关注点更集中、跑得更快；
//   2) 真实 Storage 会经 better-sqlite3 创建预编译语句，在 Node 24 下若语句被 GC
//      析构会触发原生断言 Assertion failed: (env) != nullptr 直接中止进程（本机
//      Node 22 不复现，CI 的 Node 24 会红）。媒体路由只用到 getMessage 与 archiveRoot，
//      因此用假 Storage 能彻底规避该原生模块问题。
//
// 假的 storage 必须提供 media.js 里 resolveMedia 用到的两个成员。
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cv-media-'));
const archiveRoot = path.join(tmp, 'archive');
fs.mkdirSync(archiveRoot, { recursive: true });

const messages = new Map();
const storage = {
  archiveRoot,
  getMessage(id) {
    return messages.get(Number(id)) || null;
  },
};

let nextId = 1;
function register(name) {
  const id = nextId++;
  messages.set(id, { id, kind: 'file', filename: name, media: name });
  return id;
}

function startServer(app) {
  return new Promise((resolve) => {
    const server = http.createServer(app);
    server.listen(0, () => resolve(server));
  });
}

let server;
let baseUrl;
let zipId;
let tgzId;
let docxId;

before(async () => {
  // 构造测试用 zip
  const zip = new AdmZip();
  zip.addFile('a.txt', Buffer.from('hello'));
  zip.addFile('dir/b.txt', Buffer.from('world'));
  zip.writeZip(path.join(archiveRoot, 'sample.zip'));

  // 构造测试用 tar.gz
  const srcDir = path.join(tmp, 'src');
  fs.mkdirSync(srcDir, { recursive: true });
  fs.writeFileSync(path.join(srcDir, 'c.txt'), 'tar content');
  await tar.create({ gzip: true, file: path.join(archiveRoot, 'sample.tgz'), cwd: srcDir }, ['c.txt']);

  // 构造最小可用 docx（本质是 zip + 固定部件）
  const dz = new AdmZip();
  dz.addFile(
    '[Content_Types].xml',
    Buffer.from(
      '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
        '<Default Extension="xml" ContentType="application/xml"/>' +
        '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
        '</Types>',
    ),
  );
  dz.addFile(
    '_rels/.rels',
    Buffer.from(
      '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
        '</Relationships>',
    ),
  );
  dz.addFile(
    'word/document.xml',
    Buffer.from(
      '<?xml version="1.0" encoding="UTF-8"?>' +
        '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>' +
        '<w:p><w:r><w:t>爪匣归档测试文档</w:t></w:r></w:p>' +
        '</w:body></w:document>',
    ),
  );
  dz.writeZip(path.join(archiveRoot, 'sample.docx'));

  zipId = register('sample.zip');
  tgzId = register('sample.tgz');
  docxId = register('sample.docx');

  const app = express();
  app.use('/api/media', createMediaRouter({ storage }));
  server = await startServer(app);
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  if (server) server.close();
});

test('GET /api/media/list/:id 列出 zip 内文件', async () => {
  const res = await fetch(`${baseUrl}/api/media/list/${zipId}`);
  assert.equal(res.status, 200);
  const j = await res.json();
  const names = j.entries.map((e) => e.name);
  assert.ok(names.includes('a.txt'));
  assert.ok(names.includes('dir/b.txt'));
  const a = j.entries.find((e) => e.name === 'a.txt');
  assert.equal(a.size, 5);
  assert.equal(a.dir, false);
});

test('GET /api/media/list/:id 列出 tgz 内文件', async () => {
  const res = await fetch(`${baseUrl}/api/media/list/${tgzId}`);
  assert.equal(res.status, 200);
  const j = await res.json();
  assert.ok(j.entries.some((e) => e.name.includes('c.txt')));
});

test('GET /api/media/list/:id 非压缩包返回 415', async () => {
  const res = await fetch(`${baseUrl}/api/media/list/${docxId}`);
  assert.equal(res.status, 415);
});

test('GET /api/media/preview/:id 把 docx 渲染为 HTML', async () => {
  const res = await fetch(`${baseUrl}/api/media/preview/${docxId}`);
  assert.equal(res.status, 200);
  assert.ok((res.headers.get('content-type') || '').includes('text/html'));
  const html = await res.text();
  assert.ok(html.includes('爪匣归档测试文档'));
});

test('GET /api/media/preview/:id 非 Office 返回 415', async () => {
  const res = await fetch(`${baseUrl}/api/media/preview/${zipId}`);
  assert.equal(res.status, 415);
});

test('GET /api/media/:id?inline=1 使用 inline 处置（PDF 才能内嵌预览）', async () => {
  const inline = await fetch(`${baseUrl}/api/media/${zipId}?inline=1`);
  assert.equal(inline.status, 200);
  assert.ok((inline.headers.get('content-disposition') || '').startsWith('inline'));

  const attach = await fetch(`${baseUrl}/api/media/${zipId}`);
  assert.equal(attach.status, 200);
  assert.ok((attach.headers.get('content-disposition') || '').startsWith('attachment'));
});

test('GET /api/media/info/:id 返回文件名/大小/MIME/扩展名', async () => {
  const res = await fetch(`${baseUrl}/api/media/info/${zipId}`);
  assert.equal(res.status, 200);
  const j = await res.json();
  assert.equal(j.filename, 'sample.zip');
  assert.equal(j.ext, 'zip');
  assert.equal(j.mime, 'application/zip');
  assert.ok(j.size > 0);
});

test('路径穿越被拒绝（403）', async () => {
  const evilId = register('../evil.zip');
  const res = await fetch(`${baseUrl}/api/media/list/${evilId}`);
  assert.equal(res.status, 403);
});
