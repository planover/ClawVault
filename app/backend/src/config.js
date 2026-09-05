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
    // 归档回执的"空闲窗口"：会话静默这么久之后，才发一封汇总回执。
    // 回执口径是「当天累计」，窗口只决定多久发一次、以及一次合并多少条。
    // 人的正常打字间隔通常在 10~30 秒，原默认 3.5s 太短，
    // 导致几乎每条消息各发一封、且每封都只报 1 条。
    receipt_idle_ms: 45000,
  },
  // 网址快照：消息里出现 http(s) 链接时自动归档该网页
  links: {
    enabled: true,
    // 单条消息最多抓几个链接（防止一段文本贴 20 个链接把归档打爆）
    maxUrlsPerMessage: 3,
    // 抓取与截图的超时（毫秒）
    timeoutMs: 15000,
    // 单页 HTML / 单张封面图的体积上限（字节），防异常大页面吃满内存
    maxBytes: 2 * 1024 * 1024,
    // 截图开关。需要 Chromium（opt-in）：检测不到浏览器时会自动跳过，
    // 元数据卡片与 HTML 全文归档不受影响。
    screenshot: true,
    // 出网代理（可选）：fnOS 应用沙箱本地无出站 DNS，配置受信代理后网页快照/截图
    // 经由代理出网（DNS 由代理侧解析），真机联网后即可正常抓取。
    // 也可通过环境变量 LINKS_PROXY / HTTPS_PROXY / HTTP_PROXY 指定。
    proxy: env('LINKS_PROXY', ''),
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
  links: {
    enabled: env('LINKS_ENABLED', String(DEFAULTS.links.enabled)) !== 'false',
    maxUrlsPerMessage: parseInt(env('LINKS_MAX_URLS', DEFAULTS.links.maxUrlsPerMessage), 10),
    timeoutMs: parseInt(env('LINKS_TIMEOUT_MS', DEFAULTS.links.timeoutMs), 10),
    maxBytes: parseInt(env('LINKS_MAX_BYTES', DEFAULTS.links.maxBytes), 10),
    screenshot: env('LINKS_SCREENSHOT', String(DEFAULTS.links.screenshot)) !== 'false',
    // Chromium 可执行文件路径（opt-in）。留空则自动探测常见路径，
    // 探测不到就跳过截图。也可用环境变量 CLAWVAULT_CHROMIUM 指定。
    chromiumPath: env('CHROMIUM_PATH', ''),
    // 出网代理（v1.0.40 修复）：此前 proxy 只在 DEFAULTS.links 里定义、导出的
    // config.links 漏了这个字段，导致 config.links?.proxy 永远是 undefined，
    // 文档中「优先读配置项 links.proxy」实际从未生效，只有环境变量能用。
    proxy: env('LINKS_PROXY', DEFAULTS.links.proxy),
    // Chromium 沙箱（SEC-10）：默认**开启**沙箱。--no-sandbox 会让渲染器直接以
    // 应用用户权限运行，一旦 Chromium 自身有漏洞即可逃逸到宿主机。
    // 仅在确实是受限容器环境（无法创建 namespace）时才由用户显式关闭。
    chromiumNoSandbox: env('CHROMIUM_NO_SANDBOX', 'false') === 'true',
    // CDP 端点（FUN-3）：真机无 Chromium 时可复用已有浏览器服务
    // （如宿主机 docker 里的 browserless/chrome）。留空则按本地可执行路径探测。
    // 这是 opt-in 能力，留空时行为与之前完全一致。
    cdpEndpoint: env('LINKS_CDP_ENDPOINT', ''),
  },
  // 语音转码（SEC-09）：ffmpeg 处理的是来源不可信的音频，
  // 必须设超时与体积上限，避免畸形输入把进程挂住或吃满内存。
  transcode: {
    timeoutMs: parseInt(env('TRANSCODE_TIMEOUT_MS', '30000'), 10),
    maxBytes: parseInt(env('TRANSCODE_MAX_BYTES', String(32 * 1024 * 1024)), 10),
  },
  demoMode: env('DEMO_MODE', String(DEFAULTS.demo_mode)) === 'true',
};

// 注意：dataDir / archiveRoot 的物理创建不在此处进行（避免导入时的副作用，
// 同时避免在无写权限环境如 CI runner 上抛 EACCES）。它们由各自的消费者
// 负责创建：Storage 构造时会 mkdir dataDir + archiveRoot（src/storage.js），
// ChannelManager 构造时会 mkdir dataDir（src/manager.js）。
export default config;
