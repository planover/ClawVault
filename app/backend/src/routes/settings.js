import { Router } from 'express';
import { testConnection } from '../classify.js';

export default function createSettingsRouter({ config, storage, saveSettings }) {
  const r = Router();

  const publicAi = () => ({ ...config.ai, apiKey: config.ai.apiKey ? '******' : '' });

  r.get('/', (req, res) => {
    res.json({
      ai: publicAi(),
      ingest: config.ingest,
      classification: config.classification,
      archiveRoot: config.archiveRoot,
      demoMode: config.demoMode,
      total: storage.count(),
    });
  });

  r.post('/', (req, res) => {
    const b = req.body || {};
    if (b.ai) Object.assign(config.ai, b.ai);
    if (b.ingest) Object.assign(config.ingest, b.ingest);
    if (b.classification) Object.assign(config.classification, b.classification);
    if (b.archiveRoot) config.archiveRoot = b.archiveRoot;
    config.ai.enabled = Boolean(config.ai.apiKey) && config.classification.enabled !== false;
    saveSettings();
    res.json({ ok: true, ai: publicAi() });
  });

  // 测试 AI 连接（用请求体里的配置，未改动则回退到已保存配置；掩码 ****** 视为沿用已存 Key）
  r.post('/test', async (req, res) => {
    const b = req.body || {};
    const apiKey = b.apiKey === '******' || !b.apiKey ? config.ai.apiKey : b.apiKey;
    const baseUrl = b.baseUrl || config.ai.baseUrl;
    const model = b.model || config.ai.model;
    if (!apiKey) return res.json({ ok: false, error: '未填写 API Key（请先在上方填入，或已保存的密钥不可用）' });
    try {
      const result = await testConnection({ apiKey, baseUrl, model });
      res.json(result);
    } catch (e) {
      res.json({ ok: false, error: e.message || String(e) });
    }
  });

  return r;
}
