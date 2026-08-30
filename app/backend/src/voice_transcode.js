import { spawn } from 'node:child_process';
import { detectMediaExt } from './ilink_crypto.js';

// 微信 iLink 语音常见格式：SILK v3 / AMR / WEBM / MP3。
// 浏览器原生只支持 MP3/WAV/OGG/AAC/FLAC/WEBM，不支援 SILK/AMR。
// 本模块在落盘时把 SILK/AMR 转码为浏览器可播放的 WAV/MP3。

const PLAYABLE_AUDIO = ['mp3', 'wav', 'ogg', 'oga', 'm4a', 'aac', 'flac', 'webm'];

// 该扩展名是否是浏览器可直接播放的音频。
// 语音路由用它判断历史文件需不需要"现取现转"——
// 早期 isSilk 的 bug 让一批语音以 .comc2 裸 SILK 落盘，这些老数据必须靠即时转码救回来。
export function isPlayableExt(ext) {
  return PLAYABLE_AUDIO.includes(String(ext || '').toLowerCase());
}

// 微信 SILK 头的两种形态（NAS 真机取样确认）：
//   1) 标准：  "#!SILK_V3..."
//   2) 带前缀："\x02#!SILK_V3..."（多一个 0x02 字节，微信 comc2 语音常见）
// 注意下标：带前缀时 'SILK' 位于 3..6，**不是** 1..4。
// 早期写成 1..5（取到 '#!SI'）导致整批语音都被判成"不是 SILK"，
// 于是不转码、以 .comc2 存裸 SILK，浏览器无法解码 → 语音条显示 0:00。
export function isSilk(buf) {
  if (!buf || buf.length < 12) return false;
  const head = buf.toString('ascii', 0, 10);
  if (head.startsWith('#!SILK_V3')) return true;
  if (buf.toString('ascii', 0, 4) === 'SILK') return true;
  if (buf[0] === 0x02 && buf.toString('ascii', 3, 7) === 'SILK') return true;
  return false;
}

export function isAmr(buf) {
  return buf && buf.length >= 6 && buf.toString('ascii', 0, 5) === '#!AMR';
}

// 将 PCM s16le 打包成标准 WAV（浏览器可直接播放）。
function pcmToWav(pcm, sampleRate = 24000, channels = 1, bits = 16) {
  const byteRate = (sampleRate * channels * bits) / 8;
  const blockAlign = (channels * bits) / 8;
  const dataSize = pcm.length;
  const totalSize = 36 + dataSize;
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(totalSize, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16); // Subchunk1Size
  header.writeUInt16LE(1, 20); // AudioFormat = PCM
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bits, 34);
  header.write('data', 36);
  header.writeUInt32LE(dataSize, 40);
  return Buffer.concat([header, pcm]);
}

// 通过 ffmpeg 将输入音频流转码为 outputExt（默认 mp3）。
function ffmpegPipe(input, outputExt = 'mp3') {
  return new Promise((resolve, reject) => {
    const child = spawn('ffmpeg', [
      '-hide_banner',
      '-loglevel', 'error',
      '-i', '-',
      '-f', outputExt,
      '-',
    ]);
    const out = [];
    let err = '';
    child.stdout.on('data', (d) => out.push(d));
    child.stderr.on('data', (d) => {
      err += d.toString();
    });
    child.on('error', (e) => reject(e));
    child.on('close', (code) => {
      if (code === 0) return resolve(Buffer.concat(out));
      reject(new Error(`ffmpeg 退出码 ${code}: ${err.slice(0, 240)}`));
    });
    child.stdin.write(input);
    child.stdin.end();
  });
}

// 尝试用 silk-wasm 把 SILK 解码为 PCM 并封装成 WAV。
// 要点（NAS 真机实测）：
//   - 必须把 **原始** buffer 交给 decode()，库自己会处理 "#!SILK_V3" 头与 0x02 前缀；
//     任何"帮他剥前缀/跳 magic"的预处理都会让解码失败（实测 strip 后全部 FAIL）。
//   - 采样率按微信常见值依次尝试，第一个成功的即可。
async function silkToWav(buf) {
  let silk;
  try {
    silk = await import('silk-wasm');
  } catch (e) {
    throw new Error(`silk-wasm 未安装或导入失败: ${e.message}`);
  }
  if (!silk.decode) throw new Error('silk-wasm 没有 decode 导出');
  let lastErr = null;
  for (const sr of [24000, 16000, 12000, 8000]) {
    try {
      const res = await silk.decode(buf, sr); // 原样传入，不做任何裁剪
      if (!res || !res.data) throw new Error('silk-wasm 返回空数据');
      const pcm = Buffer.from(res.data.buffer || res.data, res.data.byteOffset || 0, res.data.byteLength);
      if (!pcm.length) throw new Error('解码结果为空');
      return pcmToWav(pcm, sr, 1, 16);
    } catch (e) {
      lastErr = e;
    }
  }
  throw new Error(`silk-wasm 解码失败（已试 24000/16000/12000/8000）: ${lastErr?.message}`);
}

// 把解密后的语音 buffer 转码成浏览器可播放格式。
// 返回 { buffer, ext, playable }；playable=false 表示转码失败，仍保留原格式。
export async function transcodeVoice(buf, extHint = '') {
  if (!buf || buf.length < 12) return { buffer: buf, ext: extHint || 'mp3', playable: true };
  const detected = detectMediaExt(buf);
  const ext = detected || extHint || 'mp3';
  if (PLAYABLE_AUDIO.includes(ext)) {
    return { buffer: buf, ext, playable: true };
  }

  // SILK：优先用纯 JS/WASM 解码器，无额外系统依赖。
  if (isSilk(buf)) {
    try {
      const wav = await silkToWav(buf);
      return { buffer: wav, ext: 'wav', playable: true };
    } catch (e) {
      console.error('[ClawVault] SILK 语音转码失败:', e.message);
      return { buffer: buf, ext: 'silk', playable: false };
    }
  }

  // AMR：用 ffmpeg 转码为 MP3。
  if (isAmr(buf) || ext === 'amr') {
    try {
      const mp3 = await ffmpegPipe(buf, 'mp3');
      if (mp3.length < 100) throw new Error('ffmpeg 输出过短');
      return { buffer: mp3, ext: 'mp3', playable: true };
    } catch (e) {
      console.error('[ClawVault] AMR 语音 ffmpeg 转码失败:', e.message);
      return { buffer: buf, ext: 'amr', playable: false };
    }
  }

  // 未知格式：按原样返回，让浏览器尝试播放（通常仍会失败，但保留原始数据）。
  return { buffer: buf, ext: ext || 'mp3', playable: true };
}
