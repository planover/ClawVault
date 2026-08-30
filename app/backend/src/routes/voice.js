import { Router } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { transcodeVoice, isPlayableExt } from '../voice_transcode.js';

const MIME = {
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  oga: 'audio/ogg',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  flac: 'audio/flac',
  webm: 'audio/webm',
};

// 语音音频播放（按消息 id 取落盘音频；支持 Range 以便浏览器拖动进度）
//
// 历史数据补救：早期 isSilk() 有下标错误，一批微信语音以 .comc2（裸 SILK）落盘，
// 这些扩展名既不在 MIME 表、也不是浏览器可播放格式，直接发会变成
// application/octet-stream → <audio> 解不了 → 播放器显示 0:00。
// 这里对"扩展名不可播放"的文件现取现转（SILK→WAV / AMR→MP3）再发出去，
// 老语音无需重新归档即可播放。转码失败仍按原样发出，保留原始数据。
export default function createVoiceRouter({ storage }) {
  const r = Router();

  r.get('/:id', async (req, res) => {
    const m = storage.getMessage(parseInt(req.params.id, 10));
    if (!m || !m.voice) return res.status(404).json({ error: 'not found' });
    const root = path.resolve(storage.archiveRoot);
    const abs = path.resolve(storage.archiveRoot, m.voice);
    // 路径穿越防护：解析后必须仍落在归档根内
    if (abs !== root && !abs.startsWith(root + path.sep)) {
      return res.status(403).json({ error: 'forbidden' });
    }
    if (!fs.existsSync(abs)) return res.status(404).json({ error: 'not found' });

    let ext = path.extname(abs).slice(1).toLowerCase();
    let buffer = null; // 非 null 表示走"转码后整体发出"分支
    if (!isPlayableExt(ext)) {
      try {
        const raw = fs.readFileSync(abs);
        const t = await transcodeVoice(raw, ext);
        if (t && t.playable && t.buffer && t.buffer.length) {
          buffer = t.buffer;
          ext = t.ext || 'wav';
        }
      } catch (e) {
        console.error('[voice] 即时转码失败，按原样发送:', e?.message || e);
      }
    }

    // 转码后的内容整体返回（语音文件通常只有几十 KB，不必走 Range）
    if (buffer) {
      res.set('Content-Type', MIME[ext] || 'application/octet-stream');
      res.set('Accept-Ranges', 'none');
      res.set('Content-Length', buffer.length);
      return res.end(buffer);
    }

    const stat = fs.statSync(abs);
    const type = MIME[ext] || 'application/octet-stream';
    const range = req.headers.range;

    if (range) {
      const [s, e] = range.replace(/bytes=/, '').split('-');
      let start = parseInt(s, 10);
      let end = e ? parseInt(e, 10) : stat.size - 1;
      if (isNaN(start)) start = 0;
      if (isNaN(end) || end >= stat.size) end = stat.size - 1;
      if (start > end) {
        res.status(416).set('Content-Range', `bytes */${stat.size}`);
        return res.end();
      }
      res.status(206);
      res.set('Content-Type', type);
      res.set('Accept-Ranges', 'bytes');
      res.set('Content-Range', `bytes ${start}-${end}/${stat.size}`);
      res.set('Content-Length', end - start + 1);
      return fs.createReadStream(abs, { start, end }).pipe(res);
    }

    res.set('Content-Type', type);
    res.set('Accept-Ranges', 'bytes');
    res.set('Content-Length', stat.size);
    fs.createReadStream(abs).pipe(res);
  });

  return r;
}
