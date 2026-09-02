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

test('非 chat 类型 reclassify：只更新 DB 标签，不生成/移动 md 文件', ser, async () => {
  const rec = storage.saveMessage({ channelId: 'c1', channelName: '通道C', peer: 'u4', text: '一张图', kind: 'image', category: '待分类' });
  assert.equal(rec.path, '', '非 chat 类不再生成 md，path 应为空');
  const countMd = (root) => {
    let n = 0;
    const walk = (d) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.name.endsWith('.md')) n += 1;
      }
    };
    walk(root);
    return n;
  };
  const before = countMd(archiveRoot);
  const updated = storage.reclassify(rec.id, '图片', '');
  assert.equal(updated.category, '图片');
  assert.equal(countMd(archiveRoot), before, 'reclassify 不应生成 md 文件');
});

test('saveMedia：图片按类型落到 图片/ 目录，文件名用消息文字做后缀', ser, async () => {
  const rec = storage.saveMessage({ channelId: 'c1', channelName: '通道D', peer: 'u5', text: '今天评审用的架构图', kind: 'image', category: '图片' });
  const rel = await storage.saveMedia({
    channelName: '通道D',
    id: rec.id,
    media: { buffer: Buffer.from('IMGDATA'), ext: 'png' },
    kind: 'image',
    text: '今天评审用的架构图',
  });
  assert.ok(rel, '应返回相对路径');
  assert.match(rel, /图片[\\/].*\.png$/, '图片应落盘到 图片/ 目录');
  assert.match(path.basename(rel, '.png'), /架构图/, '文件名应包含消息文字摘要');
  assert.equal(fs.readFileSync(path.join(archiveRoot, rel), 'utf8'), 'IMGDATA');
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
  // 契约：后端只返回干净的接口路径（以 /api/ 开头、不含网关前缀），
  // 前缀一律由前端 apiUrl() 统一拼接。v1.0.31 及之前前端直接把 downloadUrl
  // 塞进 <a href>，在飞牛网关下被解析成站点根的 /api/...，打到了飞牛自己的兜底页，
  // 表现为「点了下载没反应 / 下来一个 html」。这里钉死后端侧的契约，防止再次漏拼。
  assert.ok(f.downloadUrl.startsWith('/api/'), `downloadUrl 应是 /api/ 开头的干净路径，实际：${f.downloadUrl}`);
  assert.equal(f.downloadUrl, `/api/chats/${encodeURIComponent('通道F')}/xlsx`);
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

test('saveMessage 携带 filename 字段并能在查询中返回', ser, () => {
  const rec = storage.saveMessage({ channelId: 'c1', channelName: '通道G', peer: 'u8', text: '文件', kind: 'file', category: '文件', filename: '202604虫害+捕鼠笼点检.pdf' });
  assert.equal(rec.filename, '202604虫害+捕鼠笼点检.pdf');
  assert.equal(storage.getMessage(rec.id).filename, '202604虫害+捕鼠笼点检.pdf');
  const list = storage.listMessages({ channelId: 'c1' });
  const found = list.items.find((m) => m.id === rec.id);
  assert.equal(found?.filename, '202604虫害+捕鼠笼点检.pdf');
});

test('saveMedia：buffer 写入媒体并返回相对路径', ser, async () => {
  const rec = storage.saveMessage({ channelId: 'c1', channelName: '通道H', peer: 'u9', text: '图', kind: 'image', category: '图片' });
  const rel = await storage.saveMedia({ channelName: '通道H', id: rec.id, media: { buffer: Buffer.from('IMGDATA'), ext: 'png' }, kind: 'image', text: '图' });
  assert.ok(rel, '应返回相对路径');
  assert.match(rel, /图片[\\/].*\.png$/);
  assert.equal(fs.readFileSync(path.join(archiveRoot, rel), 'utf8'), 'IMGDATA');
});

test('saveMedia：内容相同（同通道）只存一份，返回已存在路径', ser, async () => {
  const ch = '通道去重';
  const payload = { buffer: Buffer.from('DUPLICATE-IMAGE'), ext: 'png' };
  const before = fs.existsSync(path.join(archiveRoot, ch, '图片'))
    ? fs.readdirSync(path.join(archiveRoot, ch, '图片')).filter((f) => f.endsWith('.png')).length
    : 0;
  const r1 = await storage.saveMedia({ channelName: ch, id: 1, media: { ...payload }, kind: 'image', text: '甲' });
  const r2 = await storage.saveMedia({ channelName: ch, id: 2, media: { ...payload }, kind: 'image', text: '乙' });
  assert.ok(r1 && r2, '两次都应返回路径');
  assert.equal(r1, r2, '内容相同应复用同一文件（去重）');
  // 磁盘只多出一个文件（不重复落盘）
  const after = fs.readdirSync(path.join(archiveRoot, ch, '图片')).filter((f) => f.endsWith('.png')).length;
  assert.equal(after, before + 1, '不应重复落盘');
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
  // 用 MP3 帧头（0xFF 0xFB...）模拟浏览器可直接播放的明文语音，避免触发转码
  const sample = Buffer.concat([Buffer.from([0xff, 0xfb, 0x90, 0x00]), Buffer.from('MP3payload-content')]);
  const cipher = crypto.createCipheriv('aes-128-ecb', key, null);
  const enc = Buffer.concat([cipher.update(sample), cipher.final()]);
  const rel = await storage.saveVoiceFile({ channelName: '通道A', media: { buffer: enc, aesKey, ext: 'bin' } });
  assert.ok(rel && rel.endsWith('.mp3'), '应按真实文件头判定为 mp3');
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

test('migrateOldMedia：旧 媒体/ 文件按类型迁移到 图片/文件/视频/语音 并清理 md 卡片', ser, () => {
  const s = new Storage({ dataDir: path.join(tmp, 'mig-data'), archiveRoot: path.join(tmp, 'mig-archive') });
  const ch = '微信';
  fs.mkdirSync(path.join(tmp, 'mig-archive', ch, '媒体'), { recursive: true });
  fs.mkdirSync(path.join(tmp, 'mig-archive', ch, '图片'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'mig-archive', ch, '媒体', 'a.png'), 'PNGDATA');
  fs.writeFileSync(path.join(tmp, 'mig-archive', ch, '媒体', 'b.pdf'), 'PDFDATA');
  fs.writeFileSync(path.join(tmp, 'mig-archive', ch, '图片', 'x.md'), '# ClawVault 对话归档\n\n旧卡片\n');
  // DB 中消息指向旧 媒体/ 路径
  s.saveMessage({ channelId: 'm', channelName: ch, peer: 'u', text: '图', kind: 'image', category: '图片', media: '微信/媒体/a.png' });
  s.saveMessage({ channelId: 'm', channelName: ch, peer: 'u', text: '文件', kind: 'file', category: '文件', media: '微信/媒体/b.pdf' });

  const stats = s.migrateOldMedia();
  assert.ok(stats.moved >= 2, `应移动至少 2 个文件，实际 ${JSON.stringify(stats)}`);
  assert.ok(stats.cardsRemoved >= 1, `应清理 md 卡片，实际 ${JSON.stringify(stats)}`);

  const items = s.listMessages({ channelId: 'm' }).items;
  const img = items.find((m) => m.kind === 'image');
  const file = items.find((m) => m.kind === 'file');
  assert.match(img.media, /图片[\\/].*\.png$/, '图片应迁移到 图片/');
  assert.match(file.media, /文件[\\/].*\.pdf$/, '文件应迁移到 文件/');
  assert.ok(fs.existsSync(path.join(tmp, 'mig-archive', ch, '图片', path.basename(img.media))), '图片文件应在 图片/');
  assert.ok(fs.existsSync(path.join(tmp, 'mig-archive', ch, '文件', path.basename(file.media))), '文件应在 文件/');
  assert.ok(!fs.existsSync(path.join(tmp, 'mig-archive', ch, '媒体', 'a.png')), '旧 媒体/ 文件应已移走');
  assert.ok(!fs.existsSync(path.join(tmp, 'mig-archive', ch, '图片', 'x.md')), 'md 卡片应已清理');
});


