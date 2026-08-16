import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import ExcelJS from 'exceljs';
import { Storage } from '../src/storage.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fnclaw-store-'));
const archiveRoot = path.join(tmp, 'archive');
const dataDir = path.join(tmp, 'data');
const storage = new Storage({ dataDir, archiveRoot });

const ser = { execution: 'serial' };

test('Storage.isChat 判定 chat 类型', ser, () => {
  assert.equal(Storage.isChat('text'), true);
  assert.equal(Storage.isChat('voice'), true);
  assert.equal(Storage.isChat('image'), false);
  assert.equal(Storage.isChat('file'), false);
  assert.equal(Storage.isChat(''), false);
});

test('chat 模式保存：纯文本不写 Markdown，path 指向 聊天.xlsx', ser, () => {
  const rec = storage.saveMessage({ channelId: 'c1', channelName: '通道A', peer: 'u1', text: '你好世界', kind: 'text', category: '待分类' });
  assert.ok(rec.id);
  assert.equal(path.basename(rec.path), '聊天.xlsx');
  const mdFiles = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.md')) mdFiles.push(p);
    }
  };
  walk(archiveRoot);
  assert.equal(mdFiles.length, 0, 'chat 模式不应生成 .md 文件');
});

test('appendChatRow：纯文本与语音都能写入 聊天.xlsx', ser, async () => {
  await storage.appendChatRow({ channelName: '通道A', row: { ts: Date.now() - 1000, channel: '通道A', peer: 'u1', category: '工作', sub: '项目', text: '纯文本内容', voice: '' } });
  await storage.appendChatRow({ channelName: '通道A', row: { ts: Date.now(), channel: '通道A', peer: 'u2', category: '语音', sub: '', text: '语音转写文字', voice: '通道A/语音/abc.mp3' } });

  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(storage._chatFile('通道A'));
  const ws = wb.worksheets[0];
  assert.equal(ws.rowCount, 3, '1 表头 + 2 数据行');
  assert.equal(ws.getRow(2).getCell(6).value, '纯文本内容');
  const voiceCell = ws.getRow(3).getCell(7).value;
  assert.ok(voiceCell && voiceCell.hyperlink, '语音列应为超链接');
  assert.match(voiceCell.hyperlink, /file:\/\//);
});

test('saveVoiceFile：buffer 写入音频并返回相对路径', ser, async () => {
  const rel = await storage.saveVoiceFile({ channelName: '通道A', media: { buffer: Buffer.from('FAKEMP3'), ext: 'mp3' } });
  assert.ok(rel, '应返回相对路径');
  assert.match(rel, /语音[\\/].*\.mp3$/);
  const abs = path.join(archiveRoot, rel);
  assert.ok(fs.existsSync(abs), '音频文件应已落盘');
  assert.equal(fs.readFileSync(abs, 'utf8'), 'FAKEMP3');
});

test('saveVoiceFile：无 media 返回空串', ser, async () => {
  assert.equal(await storage.saveVoiceFile({ channelName: '通道A', media: null }), '');
});

test('chat 模式 reclassify：只更新 SQLite，不写 Markdown', ser, async () => {
  const rec = storage.saveMessage({ channelId: 'c1', channelName: '通道B', peer: 'u3', text: '待分类文本', kind: 'text', category: '待分类' });
  const updated = storage.reclassify(rec.id, '技术', 'Python');
  assert.equal(updated.category, '技术');
  assert.equal(updated.sub, 'Python');
  assert.equal(path.basename(updated.path), '聊天.xlsx');
});

test('非 chat 类型 reclassify：仍落 Markdown 文件', ser, async () => {
  const rec = storage.saveMessage({ channelId: 'c1', channelName: '通道C', peer: 'u4', text: '一张图', kind: 'image', category: '待分类' });
  const md1 = rec.path;
  assert.ok(md1.endsWith('.md'));
  const updated = storage.reclassify(rec.id, '图片', '');
  assert.ok(updated.path.endsWith('.md'));
  assert.notEqual(updated.path, md1, '应移动到新分类目录');
});

test('Markdown 落盘标题平台无关（ClawVault 对话归档，非写死微信）', ser, () => {
  const rec = storage.saveMessage({ channelId: 'c1', channelName: '通道D', peer: 'u5', text: '图示', kind: 'image', category: '图片' });
  const md = fs.readFileSync(rec.path, 'utf8');
  assert.match(md, /ClawVault 对话归档/);
  assert.doesNotMatch(md, /微信对话归档/);
});

test('saveMessage 携带 voice 字段；setVoice 可回填', ser, () => {
  const rec = storage.saveMessage({ channelId: 'c1', channelName: '通道E', peer: 'u6', text: '语音', kind: 'voice', category: '语音', voice: '通道E/语音/x.mp3' });
  assert.equal(rec.voice, '通道E/语音/x.mp3');
  assert.equal(storage.getMessage(rec.id).voice, '通道E/语音/x.mp3');
  storage.setVoice(rec.id, '通道E/语音/y.mp3');
  assert.equal(storage.getMessage(rec.id).voice, '通道E/语音/y.mp3');
});

test('listChatArchives：能列出通道的 聊天.xlsx 与统计', ser, async () => {
  // 先落一条聊天消息（写 DB），再追加到 聊天.xlsx，模拟真实归档链路
  storage.saveMessage({ channelId: 'c1', channelName: '通道F', peer: 'u7', text: '行1', kind: 'text', category: '工作', voice: '通道F/语音/a.mp3' });
  await storage.appendChatRow({ channelName: '通道F', row: { ts: Date.now(), channel: '通道F', peer: 'u7', category: '工作', sub: '', text: '行1', voice: '通道F/语音/a.mp3' } });
  const list = storage.listChatArchives();
  const f = list.find((x) => x.channel === '通道F');
  assert.ok(f, '应列出通道F');
  assert.ok(f.rows >= 1);
  assert.equal(f.hasVoice, true);
  assert.ok(f.downloadUrl.endsWith('/xlsx'));
});

test('appendChatRow 并发写入同一通道不丢行（串行队列）', ser, async () => {
  const N = 8;
  await Promise.all(
    Array.from({ length: N }, (_, i) =>
      storage.appendChatRow({ channelName: '通道Q', row: { ts: Date.now(), channel: '通道Q', peer: 'u', category: '测试', sub: '', text: `并发${i}`, voice: '' } }),
    ),
  );
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(storage._chatFile('通道Q'));
  assert.equal(wb.worksheets[0].rowCount, 1 + N, '表头 + N 行应全部保留');
});

test('saveMessage 携带 media 字段；setMedia 可回填', ser, () => {
  const rec = storage.saveMessage({ channelId: 'c1', channelName: '通道G', peer: 'u8', text: '图', kind: 'image', category: '图片', media: '通道G/媒体/x.png' });
  assert.equal(rec.media, '通道G/媒体/x.png');
  assert.equal(storage.getMessage(rec.id).media, '通道G/媒体/x.png');
  storage.setMedia(rec.id, '通道G/媒体/y.png');
  assert.equal(storage.getMessage(rec.id).media, '通道G/媒体/y.png');
});

test('saveMedia：buffer 写入媒体并返回相对路径', ser, async () => {
  const rec = storage.saveMessage({ channelId: 'c1', channelName: '通道H', peer: 'u9', text: '图', kind: 'image', category: '图片' });
  const rel = await storage.saveMedia({ channelName: '通道H', id: rec.id, media: { buffer: Buffer.from('IMGDATA'), ext: 'png' } });
  assert.ok(rel, '应返回相对路径');
  assert.match(rel, /媒体[\\/].*\.png$/);
  assert.equal(fs.readFileSync(path.join(archiveRoot, rel), 'utf8'), 'IMGDATA');
});

test('saveMedia：URL 下载（mock fetch）写入媒体', ser, async () => {
  const origFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(Buffer.from('URLDATA'), { status: 200 });
  try {
    const rec = storage.saveMessage({ channelId: 'c1', channelName: '通道I', peer: 'u10', text: '图', kind: 'image', category: '图片' });
    const rel = await storage.saveMedia({ channelName: '通道I', id: rec.id, media: { url: 'https://example.com/a.jpg', ext: 'jpg' } });
    assert.ok(rel && rel.endsWith('.jpg'), '应按扩展名落盘');
    assert.equal(fs.readFileSync(path.join(archiveRoot, rel), 'utf8'), 'URLDATA');
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('saveMedia：无 media 返回空串', ser, async () => {
  assert.equal(await storage.saveMedia({ channelName: '通道H', id: 1, media: null }), '');
});

test('stats：总数/按类型/按分类/媒体缺口统计正确', ser, () => {
  // 用独立 Storage 实例，避免与上方用例共享计数
  const s2 = new Storage({ dataDir: path.join(tmp, 'stats-data'), archiveRoot: path.join(tmp, 'stats-archive') });
  s2.saveMessage({ channelId: 'c1', channelName: '通道J', peer: 'u', text: '有图', kind: 'image', category: '图片', media: '通道J/媒体/a.png' });
  s2.saveMessage({ channelId: 'c1', channelName: '通道J', peer: 'u', text: '无图', kind: 'image', category: '图片' });
  s2.saveMessage({ channelId: 'c1', channelName: '通道J', peer: 'u', text: '视频', kind: 'video', category: '视频' });
  s2.saveMessage({ channelId: 'c1', channelName: '通道J', peer: 'u', text: '文本', kind: 'text', category: '工作' });
  const s = s2.stats();
  assert.equal(s.total, 4);
  assert.equal(s.byKind.image, 2);
  assert.equal(s.byKind.video, 1);
  assert.equal(s.byKind.text, 1);
  // 缺媒体：image(无图) + video = 2；带媒体的 image 不计入
  assert.equal(s.mediaGaps, 2);
  assert.equal(s.mediaStored, 1);
  assert.ok(s.byCategory.find((c) => c.category === '图片' && c.count === 2));
});

test('listMessages：kind 类型筛选生效', ser, () => {
  const s3 = new Storage({ dataDir: path.join(tmp, 'kind-data'), archiveRoot: path.join(tmp, 'kind-archive') });
  s3.saveMessage({ channelId: 'c1', channelName: '通道K', peer: 'u', text: 't1', kind: 'text', category: '工作' });
  s3.saveMessage({ channelId: 'c1', channelName: '通道K', peer: 'u', text: 'i1', kind: 'image', category: '图片', media: 'x.png' });
  s3.saveMessage({ channelId: 'c1', channelName: '通道K', peer: 'u', text: 'v1', kind: 'voice', category: '待分类' });
  const all = s3.listMessages({});
  assert.equal(all.total, 3);
  const images = s3.listMessages({ kind: 'image' });
  assert.equal(images.total, 1);
  assert.equal(images.items[0].kind, 'image');
  const noImage = s3.listMessages({ kind: 'voice' });
  assert.equal(noImage.total, 1);
  assert.equal(noImage.items[0].kind, 'voice');
});

test('saveVoiceFile：带 aesKey 自动 AES-128-ECB 解密并据真实文件头判定扩展名', ser, async () => {
  const crypto = await import('node:crypto');
  const key = crypto.createHash('md5').update('voicekey').digest(); // 16 字节
  const aesKey = key.toString('hex');
  const sample = Buffer.concat([Buffer.from([0x23, 0x21, 0x41, 0x4d, 0x52]), Buffer.from('AMRpayload-content')]); // #!AMR 头
  const cipher = crypto.createCipheriv('aes-128-ecb', key, null);
  const enc = Buffer.concat([cipher.update(sample), cipher.final()]);
  const rel = await storage.saveVoiceFile({ channelName: '通道A', media: { buffer: enc, aesKey, ext: 'bin' } });
  assert.ok(rel && rel.endsWith('.amr'), '应按真实文件头判定为 amr');
  assert.equal(fs.readFileSync(path.join(archiveRoot, rel)).toString(), sample.toString(), '应解密还原为原始音频明文');
});

test('renameChannel：更新 channel_name、重写路径前缀并物理改名文件夹', ser, () => {
  const s = new Storage({ dataDir: path.join(tmp, 'ren-data'), archiveRoot: path.join(tmp, 'ren-archive') });
  s.saveMessage({ channelId: 'cx', channelName: '旧通道', peer: 'u', text: '图', kind: 'image', category: '图片', media: '旧通道/媒体/a.png' });
  s.saveMessage({ channelId: 'cx', channelName: '旧通道', peer: 'u', text: '语音', kind: 'voice', category: '语音', voice: '旧通道/语音/b.mp3' });
  fs.mkdirSync(path.join(tmp, 'ren-archive', '旧通道', '媒体'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'ren-archive', '旧通道', '媒体', 'a.png'), 'PNG');
  const renamed = s.renameChannel({ channelId: 'cx', oldName: '旧通道', newName: '新通道' });
  assert.equal(renamed, true);
  const msgs = s.listMessages({ channelId: 'cx' }).items;
  const img = msgs.find((m) => m.kind === 'image');
  const voice = msgs.find((m) => m.kind === 'voice');
  assert.equal(img.channelName, '新通道');
  assert.equal(img.media, '新通道/媒体/a.png');
  assert.equal(voice.voice, '新通道/语音/b.mp3');
  assert.ok(fs.existsSync(path.join(tmp, 'ren-archive', '新通道', '媒体', 'a.png')), '文件夹应已重命名');
  assert.ok(!fs.existsSync(path.join(tmp, 'ren-archive', '旧通道')), '旧文件夹应不存在');
});


