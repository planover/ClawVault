import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isSilk, isAmr, isPlayableExt } from '../src/voice_transcode.js';

// 构造微信 SILK 头（NAS 真机取样：hex 02232153494c4b5f56330c00）
// 即 \x02 + "#!SILK_V3" + \f \0
function silkBuffer({ prefix = true, magic = '#!SILK_V3' } = {}) {
  const parts = [];
  if (prefix) parts.push(Buffer.from([0x02]));
  parts.push(Buffer.from(magic, 'ascii'));
  parts.push(Buffer.from([0x0c, 0x00]));
  parts.push(Buffer.alloc(64)); // 假装是音频负载
  return Buffer.concat(parts);
}

test('isSilk 识别带 0x02 前缀的微信 SILK（v1.0.30 回归：旧代码按下标 1..5 取到 "#!SI" 而漏判）', () => {
  const buf = silkBuffer({ prefix: true });
  assert.equal(buf.toString('ascii', 0, 10), '\x02#!SILK_V3');
  // 明确断言 'SILK' 在下标 3..6（旧代码误判为 1..4）
  assert.equal(buf.toString('ascii', 3, 7), 'SILK');
  assert.notEqual(buf.toString('ascii', 1, 5), 'SILK');
  assert.equal(isSilk(buf), true, '带 0x02 前缀的真实微信语音必须被识别为 SILK');
});

test('isSilk 识别不带前缀的标准 SILK 头', () => {
  assert.equal(isSilk(silkBuffer({ prefix: false })), true);
});

test('isSilk 识别裸 SILK（无 #! 头）', () => {
  assert.equal(isSilk(silkBuffer({ prefix: false, magic: 'SILK' })), true);
});

test('isSilk 对非 SILK 数据返回 false（不误判）', () => {
  assert.equal(isSilk(Buffer.from('#!AMR\n\x00' + 'x'.repeat(40))), false);
  assert.equal(isSilk(Buffer.from('ID3\x03' + 'x'.repeat(60))), false); // mp3
  assert.equal(isSilk(Buffer.alloc(4)), false); // 太短
  assert.equal(isSilk(null), false);
  assert.equal(isSilk(undefined), false);
});

test('isAmr 识别 AMR 头', () => {
  assert.equal(isAmr(Buffer.from('#!AMR\n' + 'x'.repeat(40))), true);
  assert.equal(isAmr(Buffer.from('#!SILK_V3' + 'x'.repeat(40))), false);
});

test('isPlayableExt：可播放扩展名与遗留 .comc2 的判定', () => {
  for (const e of ['mp3', 'wav', 'ogg', 'oga', 'm4a', 'aac', 'flac', 'webm']) {
    assert.equal(isPlayableExt(e), true, `${e} 应可播放`);
  }
  // 关键：早期 bug 让语音以 .comc2 落盘，必须判定为"不可播放"以触发即时转码
  assert.equal(isPlayableExt('comc2'), false);
  assert.equal(isPlayableExt('silk'), false);
  assert.equal(isPlayableExt('amr'), false);
  assert.equal(isPlayableExt(''), false);
  assert.equal(isPlayableExt(undefined), false);
});
