import { Router } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { resolveWithin } from '../safepath.js';
import { LINK_CATEGORY } from '../linkshot.js';

// 网址快照 API：
//   GET /api/links            收藏网址列表（支持 q / limit / offset）
//   GET /api/links/:id        单条快照详情
//   GET /api/links/:id/html   HTML 全文归档（CSP 锁死脚本后同域提供）
//   GET /api/links/:id/cover      封面图
//   GET /api/links/:id/screenshot 网页截图
//
// 安全要点：归档的 HTML 来自任意外部站点，直接在应用同源下打开等于给第三方网页
// 一个同源执行入口（可读 /api/*、可操作归档）。因此一律加 CSP 禁掉脚本与外联，
// 并强制 nosniff，绝不"存什么就原样吐什么"。
const ARCHIVE_CSP =
  "default-src 'none'; img-src * data: blob:; style-src 'unsafe-inline'; font-src data:; media-src *; frame-ancestors 'self'";

const COVER_MIME = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
};

export default function createLinksRouter({ storage } = {}) {
  const r = Router();

  r.get('/', (req, res) => {
    const { q = '', limit, offset, messageId } = req.query;
    // 按消息维度取快照：详情面板选中某条消息时调用，直接走 getLinkSnapshots
    if (messageId !== undefined && messageId !== '') {
      const items = storage.getLinkSnapshots(parseInt(messageId, 10));
      return res.json({ items, total: items.length, category: LINK_CATEGORY });
    }
    const out = storage.listLinkSnapshots({ q, limit, offset });
    res.json({ ...out, category: LINK_CATEGORY });
  });

  r.get('/:id', (req, res) => {
    const s = storage.getLinkSnapshot(parseInt(req.params.id, 10));
    if (!s) return res.status(404).json({ error: 'not found' });
    res.json(s);
  });

  // 按字段名取出快照文件并发送。越界 403 / 缺失 404（与 media.js 口径一致：
  // 越界要能和可排查的"文件没找到"区分开）。
  function sendField(field, typeOf, extraHeaders) {
    return (req, res) => {
      const s = storage.getLinkSnapshot(parseInt(req.params.id, 10));
      if (!s) return res.status(404).json({ error: 'not found' });
      const resolved = resolveWithin(storage.archiveRoot, s[field]);
      if (resolved && resolved.traversal) return res.status(403).json({ error: 'forbidden' });
      if (!resolved) return res.status(404).json({ error: 'not found' });
      const abs = resolved.abs;
      res.set('Content-Type', typeOf(abs));
      res.set('X-Content-Type-Options', 'nosniff');
      if (extraHeaders) extraHeaders(res);
      const download = req.query.download === '1';
      if (download) {
        res.set('Content-Disposition', `attachment; filename="${path.basename(abs)}"`);
      }
      fs.createReadStream(abs).pipe(res);
    };
  }

  // HTML 全文归档：禁脚本、禁外联，仅放行图片与内联样式
  r.get(
    '/:id/html',
    sendField(
      'html_path',
      () => 'text/html; charset=utf-8',
      (res) => {
        res.set('Content-Security-Policy', ARCHIVE_CSP);
      },
    ),
  );

  r.get(
    '/:id/cover',
    sendField('cover_path', (abs) => COVER_MIME[path.extname(abs).slice(1).toLowerCase()] || 'image/jpeg'),
  );

  r.get('/:id/screenshot', sendField('screenshot_path', () => 'image/png'));

  return r;
}
