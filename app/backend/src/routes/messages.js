import { Router } from 'express';

export default function createMessagesRouter({ storage, ws }) {
  const r = Router();

  r.get('/', (req, res) => {
    const { channelId, category, sub, q, limit, offset } = req.query;
    res.json(
      storage.listMessages({
        channelId,
        category,
        sub,
        q,
        limit: limit ? parseInt(limit, 10) : 50,
        offset: offset ? parseInt(offset, 10) : 0,
      }),
    );
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

  return r;
}
