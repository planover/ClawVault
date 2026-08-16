import { Router } from 'express';

export default function createChannelsRouter({ manager, storage }) {
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

  // 重命名通道（显示名）：同步更新归档文件夹与 DB 中的历史记录
  r.put('/:id', (req, res) => {
    const name = (req.body?.name || '').trim();
    if (!name) return res.status(400).json({ error: '名称不能为空' });
    try {
      const ch = manager.getChannel(req.params.id);
      if (!ch) return res.status(404).json({ error: '通道不存在' });
      const oldName = ch.name;
      storage.renameChannel({ channelId: req.params.id, oldName, newName: name });
      manager.renameChannel(req.params.id, name);
      res.json(manager.listChannels());
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
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
