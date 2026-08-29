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
function contentDisposition(filename) {
  const plain = String(filename).replace(/["\\]/g, '');
  const encoded = encodeURIComponent(plain).replace(/['()]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${plain}"; filename*=UTF-8''${encoded}`;
}

export default function createMediaRouter({ storage }) {
  const r = Router();

  // 统一解析并校验媒体文件。
  // 返回 { m, abs }；越界（media 字段被构造或数据损坏）返回 { traversal: true }；缺失返回 null。
  // 越界必须与缺失区分开：403 表示归档索引里存在可疑路径，这是需要排查的信号；
  // 若一律返回 404，真实的路径穿越尝试会被淹没在「文件没找到」里，排障时看不出来。
  function resolveMedia(id) {
    const m = storage.getMessage(parseInt(id, 10));
    if (!m || !m.media) return null;
    const root = path.resolve(storage.archiveRoot);
    const abs = path.resolve(storage.archiveRoot, m.media);
    if (abs !== root && !abs.startsWith(root + path.sep)) return { traversal: true };
    if (!fs.existsSync(abs)) return null;
    return { m, abs };
  }

  // 统一消费 resolveMedia 的三种结果：越界 403 / 缺失 404 / 正常则交给 handler
  function respond(resolved, res, ok) {
    if (resolved && resolved.traversal) return res.status(403).json({ error: 'forbidden' });
    if (!resolved) return res.status(404).json({ error: 'not found' });
    return ok(resolved.m, resolved.abs);
  }

  function serveOriginal(req, res, m, abs) {
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
      if (m.kind === 'file' && m.filename) res.set('Content-Disposition', contentDisposition(m.filename));
      return fs.createReadStream(abs, { start, end }).pipe(res);
    }

    res.set('Content-Type', type);
    res.set('Accept-Ranges', 'bytes');
    res.set('Content-Length', stat.size);
    if (m.kind === 'file' && m.filename) res.set('Content-Disposition', contentDisposition(m.filename));
    fs.createReadStream(abs).pipe(res);
  }

  // 媒体元信息：返回文件名 / 大小 / MIME / 扩展名，供前端「文件预览」展示
  // 文件名、大小、类型标识。与下载路由共用 resolveMedia 的越界/缺失判定。
  r.get('/info/:id', (req, res) => {
    const hit = resolveMedia(req.params.id);
    if (hit && hit.traversal) return res.status(403).json({ error: 'forbidden' });
    if (!hit) return res.status(404).json({ error: 'not found' });
    const { m, abs } = hit;
    let stat;
    try {
      stat = fs.statSync(abs);
    } catch {
      return res.status(404).json({ error: 'not found' });
    }
    const ext = path
      .extname(m.filename || abs)
      .slice(1)
      .toLowerCase();
    const mime = MIME[ext] || 'application/octet-stream';
    res.json({
      filename: m.filename || path.basename(abs),
      size: stat.size,
      mime,
      ext,
    });
  });

  // 缩略图：按需用 jimp（纯 JS，无原生依赖）缩放，列表/详情用更小带宽。
  // jimp 未安装或处理失败时，自动回退为原图，保证不回归。
  r.get('/thumb/:id', async (req, res) => {
    const hit = resolveMedia(req.params.id);
    if (hit && hit.traversal) return res.status(403).json({ error: 'forbidden' });
    if (!hit) return res.status(404).json({ error: 'not found' });
    const { m, abs } = hit;
    const ext = path.extname(abs).slice(1).toLowerCase();
    const imgExts = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'];
    if (!imgExts.includes(ext) || (m.kind !== 'image' && m.kind !== 'sticker')) {
      return serveOriginal(req, res, m, abs);
    }
    let w = parseInt(req.query.w, 10) || 320;
    if (w < 16) w = 16;
    if (w > 1280) w = 1280;
    try {
      // jimp 0.22 是 CommonJS：命名导入 { Jimp } 取不到，需从 default 兜底。
      // 其 module.exports 即 Jimp 类本身（也挂了 .Jimp），统一兼容两种形态。
      const mod = await import('jimp');
      const Jimp = mod.Jimp ?? (mod.default && (mod.default.Jimp ?? mod.default));
      const image = await Jimp.read(abs);
      image.scaleToFit(w, Jimp.AUTO);
      const asPng = m.kind === 'sticker' || ext === 'png' || ext === 'gif' || ext === 'webp' || ext === 'bmp';
      const mime = asPng ? 'image/png' : 'image/jpeg';
      const buf = asPng
        ? await image.getBufferAsync(Jimp.MIME_PNG)
        : await image.getBufferAsync(Jimp.MIME_JPEG);
      res.set('Content-Type', mime);
      res.set('Cache-Control', 'public, max-age=86400');
      res.set('Content-Length', buf.length);
      return res.end(buf);
    } catch {
      return serveOriginal(req, res, m, abs);
    }
  });

  r.get('/:id', (req, res) =>
    respond(resolveMedia(req.params.id), res, (m, abs) => serveOriginal(req, res, m, abs)),
  );

  return r;
}
