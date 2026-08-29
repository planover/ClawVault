import { Router } from 'express';

// 查询参数白名单化与数值收敛，避免把任意 query 直接喂给 SQL / 产生超大 limit
function parseListQuery(query) {
  const str = (v) => (typeof v === 'string' ? v : '');
  const int = (v, min, max, dflt) => {
    const n = parseInt(v, 10);
    if (!Number.isFinite(n)) return dflt;
    return Math.min(Math.max(n, min), max);
  };
  return {
    channelId: str(query.channelId),
    category: str(query.category),
    sub: str(query.sub),
    kind: str(query.kind),
    q: str(query.q),
    limit: int(query.limit, 1, 200, 50),
    offset: int(query.offset, 0, Number.MAX_SAFE_INTEGER, 0),
  };
}

export default function createMessagesRouter({ storage, ws }) {
  const r = Router();

  r.get('/', (req, res) => {
    // 注意：kind 必须透传。历史版本在这里解构了 kind 却没往下传，
    // 导致前端「文本/语音/图片…」类型筛选完全失效（点选后结果不变）。
    res.json(storage.listMessages(parseListQuery(req.query)));
  });

  r.get('/:id', (req, res) => {
    const m = storage.getMessage(parseInt(req.params.id, 10));
    if (!m) return res.status(404).json({ error: 'not found' });
    res.json(m);
  });

  r.post('/:id/reclassify', (req, res) => {
    const { category, sub } = req.body || {};
    if (!category) return res.status(400).json({ error: 'category required' });
    const updated = storage.reclassify(parseInt(req.params.id, 10), category, sub || '');
    if (!updated) return res.status(404).json({ error: 'not found' });
    ws.broadcast({ type: 'reclassify', record: updated });
    res.json(updated);
  });

  // 一次性把历史数据里「整条仅含微信表情占位符」的文本消息重新归类为表情类型，
  // 让分类 / 统计 / 样式与新写入保持一致。返回受影响条数。
  r.post('/reclassify-emoji', (req, res) => {
    try {
      const updated = storage.reclassifyEmojis();
      ws.broadcast({ type: 'refresh' });
      res.json({ ok: true, updated });
    } catch (e) {
      res.status(500).json({ error: e?.message || 'reclassify failed' });
    }
  });

  // 删除一条归档记录：同时清理不再被引用的媒体/语音文件，并按通道重写 聊天.xlsx，
  // 保证 SQLite 索引、磁盘文件、xlsx 导出三处一致。
  r.delete('/:id', async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'invalid id' });
    try {
      const out = await storage.deleteMessage(id);
      if (!out) return res.status(404).json({ error: 'not found' });
      ws.broadcast({ type: 'delete', id });
      res.json({ ok: true, ...out });
    } catch (e) {
      res.status(500).json({ error: e?.message || '删除失败' });
    }
  });

  return r;
}
