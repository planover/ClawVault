import { Router } from 'express';
import fs from 'node:fs';
import path from 'node:path';

const MIME = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  svg: 'image/svg+xml',
  mp4: 'video/mp4',
  webm: 'video/webm',
  mov: 'video/quicktime',
  mkv: 'video/x-matroska',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  oga: 'audio/ogg',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  flac: 'audio/flac',
  pdf: 'application/pdf',
  txt: 'text/plain',
  json: 'application/json',
  zip: 'application/zip',
};

// 媒体文件服务：按消息 id 取落盘的图片/文件/视频，支持 Range 以便大文件/视频拖动。
// 与语音路由一致，强制校验路径落在归档根内，防止 media 字段被构造导致路径穿越。
export default function createMediaRouter({ storage }) {
  const r = Router();

  r.get('/:id', (req, res) => {
    const m = storage.getMessage(parseInt(req.params.id, 10));
    if (!m || !m.media) return res.status(404).json({ error: 'not found' });
    const root = path.resolve(storage.archiveRoot);
    const abs = path.resolve(storage.archiveRoot, m.media);
    if (abs !== root && !abs.startsWith(root + path.sep)) {
      return res.status(403).json({ error: 'forbidden' });
    }
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
