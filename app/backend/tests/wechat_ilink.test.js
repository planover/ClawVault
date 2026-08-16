import test from 'node:test';
import assert from 'node:assert/strict';
import { wechatKind, extractMedia } from '../src/providers/wechat_ilink.js';

test('wechatKind 识别图片/视频/文件/语音/文本', () => {
  assert.equal(wechatKind({ item_list: [{ image_item: {} }] }), 'image');
  assert.equal(wechatKind({ item_list: [{ video_item: {} }] }), 'video');
  assert.equal(wechatKind({ item_list: [{ voice_item: {} }] }), 'voice');
  assert.equal(wechatKind({ item_list: [{ file_item: {} }] }), 'file');
  assert.equal(wechatKind({ item_list: [{ text_item: { text: 'hi' } }] }), 'text');
  assert.equal(wechatKind({ item_list: [{}] }), 'text');
});

test('extractMedia 从 image_item 提取直链 url 与扩展名', () => {
  const m = extractMedia({ item_list: [{ image_item: { image_url: 'http://x/a.png?k=1' } }] }, 'image');
  assert.equal(m.url, 'http://x/a.png?k=1');
  assert.equal(m.ext, 'png');
});

test('extractMedia 兼容 cdn_url / thumb_url', () => {
  const m = extractMedia({ item_list: [{ image_item: { cdn_url: 'http://cdn/b.jpg' } }] }, 'image');
  assert.equal(m.url, 'http://cdn/b.jpg');
});

test('extractMedia 无可用直链地址返回 null（触发诊断日志路径）', () => {
  const m = extractMedia({ item_list: [{ image_item: { image_id: 'abc', aes_key: 'k' } }] }, 'image');
  assert.equal(m, null);
});
