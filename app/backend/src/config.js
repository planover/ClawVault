const DEFAULTS = {
  port: 6789,
  // 飞牛统一网关：服务监听 Unix Socket（由 cmd/main 注入 SOCKET_PATH），
  // 网关校验登录态后把 /app/clawvault/** 的请求转发进来。
  // 为空则回退 TCP 端口监听（本地开发 / 非飞牛环境用）。
  socket_path: '',
  // 网关公开前缀，必须与 app/ui/config 的 gatewayPrefix 完全一致。
  // 前端资源与 API 都挂在该前缀下，后端用中间件剥离后复用原有路由。
  gateway_prefix: '',
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
    auto_reply_receipt: true,
  },
  demo_mode: false,
};

function env(name, fallback) {
  const v = process.env[name];
  if (v === undefined || v === '') return fallback;
  return v;
}

// 网关前缀标准化：去掉结尾斜杠，确保以 / 开头；空值表示不启用网关模式
function normalizePrefix(raw) {
  let p = String(raw || '').trim();
  if (!p || p === '/') return '';
  if (!p.startsWith('/')) p = '/' + p;
  return p.replace(/\/+$/, '');
}

export const config = {
  port: parseInt(env('PORT', DEFAULTS.port), 10),
  socketPath: env('SOCKET_PATH', DEFAULTS.socket_path),
  gatewayPrefix: normalizePrefix(env('GATEWAY_PREFIX', DEFAULTS.gateway_prefix)),
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

// 注意：dataDir / archiveRoot 的物理创建不在此处进行（避免导入时的副作用，
// 同时避免在无写权限环境如 CI runner 上抛 EACCES）。它们由各自的消费者
// 负责创建：Storage 构造时会 mkdir dataDir + archiveRoot（src/storage.js），
// ChannelManager 构造时会 mkdir dataDir（src/manager.js）。
export default config;
