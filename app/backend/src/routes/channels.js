import { Router } from 'express';

export default function createChannelsRouter({ manager }) {
  const r = Router();

  r.get('/', (req, res) => res.json(manager.listChannels()));

  r.post('/', async (req, res) => {
    const name = (req.body?.name || '').trim() || `通道${manager.listChannels().length + 1}`;
    const providerType = req.body?.providerType || 'wechat_ilink';
    const providerConfig = req.body?.providerConfig || {};
    const ch = manager.createChannel({ name, providerType, providerConfig });
    // 创建后即尝试连接：Webhook/Token 类瞬时完成，微信类拉起二维码
    try {
      await ch.startLogin();
    } catch {
      /* 连接失败不影响创建，前端可稍后重试 */
    }
    res.json(manager.listChannels());
  });

  r.delete('/:id', (req, res) => {
    manager.removeChannel(req.params.id);
    res.json(manager.listChannels());
  });

  r.post('/:id/login', async (req, res) => {
    try {
      const info = await manager.startLogin(req.params.id);
      res.json(info);
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  r.post('/:id/relogin', (req, res) => {
    manager.reLogin(req.params.id);
    res.json({ ok: true });
  });

  return r;
}
