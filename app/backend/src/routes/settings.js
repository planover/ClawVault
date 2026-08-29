import { Router } from 'express';
import { testConnection } from '../classify.js';

export default function createSettingsRouter({ config, storage, saveSettings }) {
  const r = Router();

  // GET 时把密钥换成占位符返回，避免明文密钥在浏览器里可读。
  // 前端表单会原样带着这个值回传，因此 POST 侧必须识别并忽略它（见下方 MASK 处理），
  // 否则用户只要打开设置点一次保存，真实密钥就会被 "******" 覆盖，AI 分类随之全废。
  const MASK = '******';
  const publicAi = () => ({ ...config.ai, apiKey: config.ai.apiKey ? MASK : '' });

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
    if (b.ai) {
      const patch = { ...b.ai };
      // 掩码 = 前端未改动密钥（用户可能只是改了归档目录）。保持原值不动。
      if (patch.apiKey === MASK || !patch.apiKey) delete patch.apiKey;
      Object.assign(config.ai, patch);
    }
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
    const apiKey = b.apiKey === MASK || !b.apiKey ? config.ai.apiKey : b.apiKey;
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
