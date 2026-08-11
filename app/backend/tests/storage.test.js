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
  assert.match(rel, /语音\/.*\.mp3$/);
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
