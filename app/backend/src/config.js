import fs from 'node:fs';

const DEFAULTS = {
  port: 6789,
  archive_root: '/archive',
  data_dir: '/data',
  ai: {
    api_key: '',
    base_url: 'https://api.anthropic.com',
    model: 'claude-sonnet-4-5',
    enabled: true,
    stt_url: '', // 可选：OpenAI 兼容的语音转写端点（/v1/audio/transcriptions），社交端无转写时用于 AI 补转
    stt_model: 'whisper-1',
  },
  classification: {
    enabled: true,
    max_categories: 30,
    allow_new: true,
    usePlatformType: true,
    system_prompt:
      '你是一个对话归档分类器。用户会给你一段与某个 bot 的对话消息，' +
      '请判断它应该归入哪个分类。分类应简洁、通用，使用中文，2-6 个字为宜。' +
      '可返回两级：主分类 category 与可选子分类 sub。只输出 JSON，不要任何解释。' +
      '示例：{"category":"工作","sub":"项目A"} 或 {"category":"灵感"}',
  },
  ingest: {
    only_bot_contacts: true,
    whitelist: [],
    auto_reply_receipt: false,
  },
  demo_mode: false,
};

function env(name, fallback) {
  const v = process.env[name];
  if (v === undefined || v === '') return fallback;
  return v;
}

export const config = {
  port: parseInt(env('PORT', DEFAULTS.port), 10),
  archiveRoot: env('ARCHIVE_ROOT', DEFAULTS.archive_root),
  dataDir: env('DATA_DIR', DEFAULTS.data_dir),
  ai: {
    apiKey: env('AI_API_KEY', DEFAULTS.ai.api_key),
    baseUrl: env('AI_BASE_URL', DEFAULTS.ai.base_url),
    model: env('AI_MODEL', DEFAULTS.ai.model),
    enabled: DEFAULTS.ai.enabled && Boolean(env('AI_API_KEY', DEFAULTS.ai.api_key)),
    sttUrl: env('STT_URL', DEFAULTS.ai.stt_url),
    sttModel: env('STT_MODEL', DEFAULTS.ai.stt_model),
  },
  classification: DEFAULTS.classification,
  ingest: DEFAULTS.ingest,
  demoMode: env('DEMO_MODE', String(DEFAULTS.demo_mode)) === 'true',
};

fs.mkdirSync(config.dataDir, { recursive: true });
fs.mkdirSync(config.archiveRoot, { recursive: true });

export default config;
