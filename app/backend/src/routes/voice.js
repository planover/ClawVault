import { Router } from 'express';
import fs from 'node:fs';
import path from 'node:path';

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

// 语音音频流式播放（按消息 id 取该条聊天消息落盘的音频文件；支持 Range 以便浏览器拖动进度）
export default function createVoiceRouter({ storage }) {
  const r = Router();

  r.get('/:id', (req, res) => {
    const m = storage.getMessage(parseInt(req.params.id, 10));
    if (!m || !m.voice) return res.status(404).json({ error: 'not found' });
    const abs = path.join(storage.archiveRoot, m.voice);
    if (!fs.existsSync(abs)) return res.status(404).json({ error: 'not found' });

    const stat = fs.statSync(abs);
    const type = MIME[path.extname(abs).slice(1).toLowerCase()] || 'application/octet-stream';
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
