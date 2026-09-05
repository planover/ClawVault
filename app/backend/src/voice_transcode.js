import { spawn } from 'node:child_process';
import { detectMediaExt } from './ilink_crypto.js';
import config from './config.js';

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
//
// SEC-09：ffmpeg 处理的是**来源不可信**的音频（webhook 推来的 base64）。
// ffmpeg 历史上有多起解码器 CVE（越界读 / RCE），且畸形输入可能让它挂住不退出。
// 因此这里加三道约束：
//   ① 入参体积上限——超限直接拒转，不交给 ffmpeg；
//   ② 硬超时——到点 SIGKILL，绝不无限等待；
//   ③ 输出体积上限——边收边判，超限立即杀进程，防解压炸弹（AMR→MP3 会放大）。
function ffmpegPipe(input, outputExt = 'mp3', { timeoutMs = 30000, maxInputBytes = 32 * 1024 * 1024, maxOutputBytes = 64 * 1024 * 1024 } = {}) {
  if (Buffer.isBuffer(input) && input.length > maxInputBytes) {
    return Promise.reject(new Error(`音频体积超出转码上限（${input.length} > ${maxInputBytes}）`));
  }
  return new Promise((resolve, reject) => {
    let child;
    let settled = false;
    const finish = (fn, arg) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(arg);
    };
    const timer = setTimeout(() => {
      try {
        child?.kill('SIGKILL');
      } catch {
        /* 已退出 */
      }
      finish(reject, new Error(`ffmpeg 转码超时（>${timeoutMs}ms）`));
    }, timeoutMs);

    child = spawn('ffmpeg', [
      '-hide_banner',
      '-loglevel', 'error',
      '-i', '-',
      '-f', outputExt,
      '-',
    ]);
    const out = [];
    let err = '';
    let outBytes = 0;
    let overflow = false;
    child.stdout.on('data', (d) => {
      outBytes += d.length;
      if (outBytes > maxOutputBytes) {
        overflow = true;
        try {
          child.kill('SIGKILL');
        } catch {
          /* 已退出 */
        }
        finish(reject, new Error(`ffmpeg 输出超出上限（>${maxOutputBytes}）`));
        return;
      }
      out.push(d);
    });
    child.stderr.on('data', (d) => {
      if (err.length < 4096) err += d.toString();
    });
    child.on('error', (e) => finish(reject, e));
    child.on('close', (code) => {
      if (overflow) return;
      if (code === 0) return finish(resolve, Buffer.concat(out));
      finish(reject, new Error(`ffmpeg 退出码 ${code}: ${err.slice(0, 240)}`));
    });
    // stdin 写入失败（进程提前退出）不应把整个进程打挂
    child.stdin.on('error', () => {});
    try {
      child.stdin.write(input);
      child.stdin.end();
    } catch (e) {
      finish(reject, e);
    }
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
  // SEC-09：体积天花板在入口处就卡住，超限的原始音频不进入任何转码路径
  const tcfg = config.transcode || {};
  const maxIn = tcfg.maxBytes || 32 * 1024 * 1024;
  if (buf.length > maxIn) {
    console.error(`[ClawVault] 语音体积超限，跳过转码（${buf.length} > ${maxIn}）`);
    return { buffer: buf, ext: extHint || 'mp3', playable: false };
  }
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
      const mp3 = await ffmpegPipe(buf, 'mp3', {
        timeoutMs: tcfg.timeoutMs || 30000,
        maxInputBytes: maxIn,
      });
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
