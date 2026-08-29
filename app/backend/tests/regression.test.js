// 回归测试：锁住已修复的缺陷，防止再次退化。
import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Storage } from '../src/storage.js';
import createMessagesRouter from '../src/routes/messages.js';
import createSettingsRouter from '../src/routes/settings.js';
import { isPureEmojiText, hasEmojiToken, extractEmojiCodes } from '../src/wechatEmoji.js';
import { renderEmojiHtml, renderEmojiText, escapeHtml } from '../../frontend/src/wechatEmoji.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'clawvault-regress-'));
const archiveRoot = path.join(tmp, 'archive');
const dataDir = path.join(tmp, 'data');

function startServer(app) {
  return new Promise((resolve) => {
    const server = http.createServer(app);
    server.listen(0, () => resolve(server));
  });
}
const base = (server) => `http://127.0.0.1:${server.address().port}`;

function freshStorage(tag) {
  return new Storage({
    dataDir: path.join(dataDir, tag),
    archiveRoot: path.join(archiveRoot, tag),
  });
}

function messagesApp(storage) {
  const app = express();
  app.use(express.json());
  app.use('/api/messages', createMessagesRouter({ storage, ws: { broadcast() {} } }));
  return app;
}

test('类型筛选：kind 必须透传到存储层（历史缺陷：前端筛选 chip 点了没反应）', async () => {
  const storage = freshStorage('kind');
  storage.saveMessage({ channelId: 'c', channelName: 'CH', peer: 'u', text: '一段文字', kind: 'text', category: 'A' });
  storage.saveMessage({ channelId: 'c', channelName: 'CH', peer: 'u', text: '一张图片', kind: 'image', category: 'A' });

  const server = await startServer(messagesApp(storage));
  try {
    const all = await (await fetch(`${base(server)}/api/messages`)).json();
    assert.equal(all.total, 2, '无筛选时应返回全部');

    const img = await (await fetch(`${base(server)}/api/messages?kind=image`)).json();
    assert.equal(img.total, 1, 'kind=image 应只返回 1 条');
    assert.equal(img.items[0].kind, 'image');

    const txt = await (await fetch(`${base(server)}/api/messages?kind=text`)).json();
    assert.equal(txt.total, 1);
    assert.equal(txt.items[0].kind, 'text');
  } finally {
    server.close();
  }
});

test('搜索：LIKE 通配符 % 与 _ 被转义，不再退化成全表匹配', async () => {
  const storage = freshStorage('like');
  storage.saveMessage({ channelId: 'c', channelName: 'CH', peer: 'u', text: '进度 100% 完成', kind: 'text', category: 'A' });
  storage.saveMessage({ channelId: 'c', channelName: 'CH', peer: 'u', text: '普通消息', kind: 'text', category: 'A' });
  storage.saveMessage({ channelId: 'c', channelName: 'CH', peer: 'u', text: '变量 a_b 的值', kind: 'text', category: 'A' });

  const server = await startServer(messagesApp(storage));
  try {
    const pct = await (await fetch(`${base(server)}/api/messages?q=${encodeURIComponent('%')}`)).json();
    assert.equal(pct.total, 1, '搜 % 只应命中真正含百分号的那条');
    assert.equal(pct.items[0].text, '进度 100% 完成');

    const under = await (await fetch(`${base(server)}/api/messages?q=${encodeURIComponent('_')}`)).json();
    assert.equal(under.total, 1, '搜 _ 只应命中真正含下划线的那条');
    assert.equal(under.items[0].text, '变量 a_b 的值');

    const kw = await (await fetch(`${base(server)}/api/messages?q=${encodeURIComponent('普通')}`)).json();
    assert.equal(kw.total, 1, '普通关键词搜索不受转义影响');
  } finally {
    server.close();
  }
});

test('删除消息：移除索引、清理无人引用的媒体文件', async () => {
  const storage = freshStorage('del');
  const rel = await storage.saveMedia({
    channelName: 'CH',
    id: 1,
    media: { buffer: Buffer.from('IMG-BYTES'), ext: 'png' },
    kind: 'image',
    text: '图',
  });
  assert.ok(rel, '媒体应成功落盘');
  const abs = path.resolve(storage.archiveRoot, rel);
  assert.equal(fs.existsSync(abs), true);

  const rec = storage.saveMessage({
    channelId: 'c',
    channelName: 'CH',
    peer: 'u',
    text: '图',
    kind: 'image',
    category: '图片',
    media: rel,
  });

  const server = await startServer(messagesApp(storage));
  try {
    const res = await fetch(`${base(server)}/api/messages/${rec.id}`, { method: 'DELETE' });
    assert.equal(res.status, 200);
    const j = await res.json();
    assert.equal(j.ok, true);
    assert.equal(j.removedFiles, 1, '应同时清理磁盘文件');

    assert.equal(fs.existsSync(abs), false, '媒体文件应已被删除');
    assert.equal(storage.getMessage(rec.id), null, '记录应已被删除');

    const gone = await fetch(`${base(server)}/api/messages/${rec.id}`, { method: 'DELETE' });
    assert.equal(gone.status, 404, '重复删除应返回 404');
  } finally {
    server.close();
  }
});

test('删除消息：去重后被其他消息引用的文件不得误删', async () => {
  const storage = freshStorage('dedup');
  const rel = await storage.saveMedia({
    channelName: 'CH',
    id: 1,
    media: { buffer: Buffer.from('SHARED-BYTES'), ext: 'png' },
    kind: 'image',
    text: '同一张图',
  });
  const m1 = storage.saveMessage({ channelId: 'c', channelName: 'CH', peer: 'u', text: '第一次', kind: 'image', category: '图片', media: rel });
  const m2 = storage.saveMessage({ channelId: 'c', channelName: 'CH', peer: 'u', text: '第二次', kind: 'image', category: '图片', media: rel });
  assert.equal(m1.media, m2.media, '内容相同应命中去重，指向同一文件');

  const abs = path.resolve(storage.archiveRoot, rel);
  await storage.deleteMessage(m1.id);

  assert.equal(fs.existsSync(abs), true, '仍有另一条消息引用，文件必须保留');
  assert.ok(storage.getMessage(m2.id), '另一条记录不受影响');
});

test('设置保存：掩码密钥不得回写覆盖真实 Key（历史缺陷：打开设置点保存即废掉 AI 分类）', async () => {
  const saved = {};
  const config = {
    ai: { apiKey: 'sk-real-key', baseUrl: 'https://api.example.com', model: 'm1', enabled: true, sttUrl: '', sttModel: 'whisper-1' },
    ingest: { only_bot_contacts: true, whitelist: [] },
    classification: { enabled: true, usePlatformType: true },
    archiveRoot: '/archive',
  };
  const app = express();
  app.use(express.json());
  app.use(
    '/api/settings',
    createSettingsRouter({
      config,
      storage: { count: () => 0 },
      saveSettings: () => {
        saved.called = true;
      },
    }),
  );
  const server = await startServer(app);
  try {
    const masked = await (await fetch(`${base(server)}/api/settings`)).json();
    assert.equal(masked.ai.apiKey, '******', 'GET 必须返回掩码');

    // 模拟用户只改了归档目录就点保存：前端会把掩码原样回传
    const res = await fetch(`${base(server)}/api/settings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ai: { ...masked.ai }, archiveRoot: '/new-archive' }),
    });
    assert.equal(res.status, 200);
    assert.equal(config.ai.apiKey, 'sk-real-key', '真实密钥必须保持不变');
    assert.equal(config.archiveRoot, '/new-archive', '其他字段仍需正常保存');
    assert.equal(saved.called, true);

    // 用户主动填入新密钥时必须生效
    await fetch(`${base(server)}/api/settings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ai: { apiKey: 'sk-new-key' } }),
    });
    assert.equal(config.ai.apiKey, 'sk-new-key', '主动填写的新密钥应被写入');
  } finally {
    server.close();
  }
});

test('聊天消息删除后重建 聊天.xlsx，导出与索引保持一致', async () => {
  const storage = freshStorage('xlsx');
  for (const t of ['第一条', '第二条', '第三条']) {
    const rec = storage.saveMessage({ channelId: 'c', channelName: 'CH', peer: 'u', text: t, kind: 'text', category: '备忘' });
    await storage.appendChatRow({ channelName: 'CH', row: { ts: rec.ts, channel: 'CH', category: '备忘', sub: '', peer: 'u', text: t, voice: '' } });
  }
  const file = storage.chatFileFor('CH');
  assert.equal(fs.existsSync(file), true);

  const all = storage.listMessages({ kind: 'text' }).items;
  assert.equal(all.length, 3);
  const victim = all.find((m) => m.text === '第二条');

  await storage.deleteMessage(victim.id);

  assert.equal(fs.existsSync(file), true, '仍有聊天记录，xlsx 应保留');
  const { rows } = await readXlsxTexts(file);
  assert.equal(rows.length, 2, 'xlsx 应只剩 2 行');
  assert.equal(rows.includes('第二条'), false, '被删消息不应残留在 xlsx 中');
  assert.equal(rows.includes('第一条'), true);
  assert.equal(rows.includes('第三条'), true);

  // 全部删完 → 空壳 xlsx 应被移除，侧栏归档列表同步消失
  for (const m of storage.listMessages({ kind: 'text' }).items) await storage.deleteMessage(m.id);
  assert.equal(fs.existsSync(file), false, '无聊天记录时应删除空壳 xlsx');
});

// 读取 xlsx 第 6 列（文字）的内容，用于校验重建结果
async function readXlsxTexts(file) {
  const ExcelJS = (await import('exceljs')).default;
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(file);
  const ws = wb.worksheets[0];
  const rows = [];
  ws.eachRow((r, i) => {
    if (i === 1) return; // 跳过表头
    rows.push(String(r.getCell(6).value ?? ''));
  });
  return { rows };
}

// ---------------- 微信表情（v1.0.27 新增） ----------------
test('微信表情：纯表情文本归类为 emoji，混合文本仍是 text', async () => {
  const storage = freshStorage('emoji-class');
  const rec = storage.saveMessage({ channelId: 'c', channelName: 'CH', peer: 'u', text: '[裂开][旺柴]', kind: '', category: 'A' });
  assert.equal(rec.kind, 'emoji', '整条仅表情占位符应归类为 emoji 类型');

  const rec2 = storage.saveMessage({ channelId: 'c', channelName: 'CH', peer: 'u', text: '哈哈[裂开]不错', kind: '', category: 'A' });
  assert.equal(rec2.kind, 'text', '含普通文字应仍为 text 类型');

  const server = await startServer(messagesApp(storage));
  try {
    const r = await (await fetch(`${base(server)}/api/messages?kind=sticker,emoji`)).json();
    assert.equal(r.total, 1, 'emoji 类型应出现在「表情」联合筛选中');
    assert.equal(r.items[0].kind, 'emoji');
  } finally {
    server.close();
  }
});

test('微信表情：未知 code 也判为表情类型（前端兜底渲染），提取保序去重', () => {
  assert.equal(isPureEmojiText('[未知表情A]'), true, '未知占位符整体也应判为表情');
  assert.equal(hasEmojiToken('普通[微笑]文本'), true);
  assert.deepEqual(extractEmojiCodes('[a][b][a][c]'), ['a', 'b', 'c'], '提取应保序去重');
});

test('微信表情渲染：占位符还原为表情符号，未知保留，XSS 安全', () => {
  const out1 = renderEmojiHtml(escapeHtml('[裂开][旺柴]'));
  assert.ok(out1.includes('🤯') && out1.includes('🐶'), '已知 code 应映射为 Unicode 表情');
  assert.ok(out1.includes('class="wx-emoji"'), '应包裹 wx-emoji span');

  const out2 = renderEmojiHtml(escapeHtml('[不存在的表情]'));
  assert.equal(out2, '[不存在的表情]', '未知 code 应保持原样，不丢信息');

  // XSS：原始标签必须被转义，禁止注入
  const out3 = renderEmojiText('[裂开]<script>alert(1)</script>');
  assert.ok(!out3.includes('<script>'), 'HTML 必须被转义，禁止注入');
  assert.ok(out3.includes('&lt;script&gt;'), '尖括号应被转义为实体');
});
