import express from 'express';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import config from './config.js';
import * as vault from './vault.js';
import { ChannelManager } from './manager.js';
import { Storage } from './storage.js';
import { classifyText, resolveClassification, textClassification } from './classify.js';
import { isPureEmojiText } from './wechatEmoji.js';
import { transcribeVoice } from './stt.js';
import { WSBroadcaster } from './ws.js';
import { listProviders } from './providers/index.js';
import createChannelsRouter from './routes/channels.js';
import createMessagesRouter from './routes/messages.js';
import createFoldersRouter from './routes/folders.js';
import createSettingsRouter from './routes/settings.js';
import createChatsRouter from './routes/chats.js';
import createVoiceRouter from './routes/voice.js';
import createMediaRouter from './routes/media.js';
import createHealthRouter from './routes/health.js';
import createAboutRouter from './routes/about.js';
import createLinksRouter from './routes/links.js';
import { createSnapshot, extractUrls, isPureUrl, urlDomain, LINK_CATEGORY } from './linkshot.js';
import { ReceiptService } from './receipt.js';

// ---- 设置持久化（覆盖默认配置） ----
// settingsVersion：写入 settings.json，用来区分"老版本留下的无意义遗留值"与
// "用户显式选过的值"。没有该标记的文件视为 1.0.28 之前保存的。
const SETTINGS_VERSION = 1;

function loadSettings() {
  const p = path.join(config.dataDir, 'settings.json');
  try {
    const s = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (s.ai) {
      const ai = { ...s.ai };
      // v1.0.32 起：落盘的 apiKey 为 AES-256-GCM 密文（与 channels.json 同源，主密钥 dataDir/.clvkey）。
      // 兼容旧版明文：解密抛错即视为明文遗留值，内存保留、下次保存自动转密文。
      if (ai.apiKey) {
        try {
          ai.apiKey = vault.decryptJSON(ai.apiKey, vault.loadKey(config.dataDir));
        } catch {
          /* 明文遗留值，保持不变 */
        }
      }
      Object.assign(config.ai, ai);
    }
    if (s.ingest) {
      const patch = { ...s.ingest };
      // 迁移：auto_reply_receipt（消息接收回执）在 v1.0.28 才真正接上代码。
      // 更早版本保存的 settings.json 里往往带着 auto_reply_receipt:false，
      // 但当时没有任何代码读它——属于无意义遗留值。若沿用它会永久覆盖新默认值
      // （true），用户升级后就会看到"回执功能不生效"。
      // 因此：文件里没有 settingsVersion 标记时丢弃该遗留值，采用新默认。
      if (!s.settingsVersion) delete patch.auto_reply_receipt;
      Object.assign(config.ingest, patch);
    }
    if (s.classification) Object.assign(config.classification, s.classification);
    if (s.archiveRoot) config.archiveRoot = s.archiveRoot;
    if (s.ownerUserId) config.ownerUserId = String(s.ownerUserId);
  } catch {
    /* 无持久化设置则用默认 */
  }
  config.ai.enabled = Boolean(config.ai.apiKey) && config.classification.enabled !== false;
}

function saveSettings() {
  const p = path.join(config.dataDir, 'settings.json');
  // apiKey 落盘加密：内存中保持明文供运行时（classify / stt / 测试接口）使用，
  // 写入磁盘前用 vault（.clvkey 主密钥）转成 AES-256-GCM 密文，避免明文密钥随备份/磁盘泄露。
  let aiOut = config.ai;
  if (config.ai.apiKey) {
    try {
      aiOut = { ...config.ai, apiKey: vault.encryptJSON(config.ai.apiKey, vault.loadKey(config.dataDir)) };
    } catch (e) {
      console.error('[ClawVault] AI Key 加密失败，按明文回退保存:', e?.message || e);
    }
  }
  fs.writeFileSync(
    p,
    JSON.stringify(
      {
        settingsVersion: SETTINGS_VERSION,
        ai: aiOut,
        ingest: config.ingest,
        classification: config.classification,
        archiveRoot: config.archiveRoot,
        ownerUserId: config.ownerUserId,
      },
      null,
      2,
    ),
    { mode: 0o600 },
  );
}

loadSettings();
config.ownerUserId = config.ownerUserId || '';

// ---- 权限分级（WEB-P1-01）----
// 飞牛网关注入 x-trim-* 身份；任意能登录飞牛的人默认可读，
// 但删除 / 改设置 / 重分类等写操作只允许管理员。
// 判定：①飞牛管理员（x-trim-isadmin=true）②设置里记录的 ownerUserId
//        （首个发起写操作的管理员自动成为 owner）。
// 无网关身份（直连 / 开发模式）放行，单用户场景不挡。
function ensureOwner(uid) {
  if (!config.ownerUserId && uid) {
    config.ownerUserId = String(uid);
    try {
      saveSettings();
    } catch {
      /* 持久化失败不影响本次放行 */
    }
  }
}
function isAdminUser(req) {
  const u = req.fnUser;
  if (!u) return false;
  if (u.isAdmin) return true;
  if (config.ownerUserId && u.uid === config.ownerUserId) return true;
  return false;
}
function requireAdmin(req, res, next) {
  if (isAdminUser(req)) return next();
  if (req.fnUser && !config.ownerUserId) {
    ensureOwner(req.fnUser.uid);
    return next();
  }
  if (!req.fnUser && !config.gatewayPrefix) return next(); // 直连 / 开发模式放行
  return res.status(403).json({ error: '需要管理员权限' });
}

// ---- 轻量限流（低危：无限流）----
// 内存固定窗口，按 用户ID（有网关身份时）或 IP 计数；不引入新依赖。
const _rateBuckets = new Map();
function rateLimit({ windowMs, max }) {
  return (req, res, next) => {
    const key = (req.fnUser && req.fnUser.uid) || req.ip || 'anon';
    const now = Date.now();
    const b = _rateBuckets.get(key);
    if (!b || now - b.start > windowMs) {
      _rateBuckets.set(key, { start: now, count: 1 });
      return next();
    }
    b.count += 1;
    if (b.count > max) {
      res.set('Retry-After', String(Math.ceil((b.start + windowMs - now) / 1000)));
      return res.status(429).json({ error: '请求过于频繁，请稍后再试' });
    }
    next();
  };
}

const startedAt = Date.now();
const storage = new Storage({ dataDir: config.dataDir, archiveRoot: config.archiveRoot });
// 旧版本媒体文件统一存在 [通道]/媒体/，迁移到按类型划分的 图片/文件/视频/语音 目录并清理遗留 md 卡片
try {
  const mig = storage.migrateOldMedia();
  if (mig.moved || mig.deduped || mig.cardsRemoved) {
    console.log(
      `[ClawVault] 旧媒体迁移完成：移动 ${mig.moved} 个、去重 ${mig.deduped} 个、清理卡片 ${mig.cardsRemoved} 个`,
    );
  }
} catch (e) {
  console.error('[ClawVault] 旧媒体迁移失败（不影响运行）:', e?.message || e);
}

// 存量数据迁移：v1.0.32 起文本消息归位到「文本消息」大类，
// 把更早期留在「未分类」下的存量文本 / 表情一次性搬过去，否则升级后看着像新规则没生效。
try {
  const mig = storage.migrateUncategorizedText();
  if (mig.text || mig.emoji) {
    console.log(`[ClawVault] 文本分类迁移完成：文本 ${mig.text} 条、表情 ${mig.emoji} 条归入对应大类`);
  }
} catch (e) {
  console.error('[ClawVault] 文本分类迁移失败（不影响运行）:', e?.message || e);
}

const ws = new WSBroadcaster();
// 归档回执服务（收到消息后自动回复发送者，详见 receipt.js）
// 计数口径为「当天累计」：查库取该会话自本地零点起的数量，
// 空闲窗口只决定多久发一封、以及一封里合并多少条。
const receipt = new ReceiptService({
  debounceMs: Number(config.ingest.receipt_idle_ms) || 45000,
  countSince: (channelId, peer, sinceTs) => storage.countMessagesByKindSince(channelId, peer, sinceTs),
});

// 链接快照：把消息正文里出现的 http(s) 链接归档为「元数据卡片 + HTML 全文 + 截图」。
//
// 刻意做成**异步非阻塞**：抓外部网页可能要几秒，绝不能拖慢入库与归档回执，
// 因此调用处不 await。抓取失败只记日志 + 落一条 fetch_failed 记录，
// 消息本身的归档完全不受影响。
async function captureLinkSnapshots(record, text) {
  if (config.links?.enabled === false) return;
  const urls = extractUrls(text);
  if (!urls.length) return;
  for (const url of urls) {
    try {
      const snap = await createSnapshot(url, { archiveRoot: storage.archiveRoot });
      const saved = storage.saveLinkSnapshot({ ...snap, messageId: record.id });
      ws.broadcast({ type: 'link_snapshot', record: { messageId: record.id, snapshot: saved } });
    } catch (e) {
      console.error('[ClawVault] 链接快照失败:', url, e?.message || e);
    }
  }
}

// 消息处理链：白名单过滤 → 存「待分类」→ 广播
//   → 纯文本 / 语音 → 写入 [通道]/聊天.xlsx（语音：社交端转写或 AI 补转，并保存音频）
//   → 其他平台类型（图片/文件/视频/链接…）→ 优先用平台判定类型归类到分类文件夹（原方式）
async function handleMessage(channel, msg) {
  const whitelist = config.ingest.whitelist || [];
  if (config.ingest.only_bot_contacts && whitelist.length && !whitelist.includes(msg.peer)) return;
  const record = storage.saveMessage({
    channelId: channel.id,
    channelName: channel.name,
    peer: msg.peer,
    text: msg.text || '',
    kind: msg.kind || '',
    category: '待分类',
    sub: '',
    filename: msg.media?.filename || '',
  });
  // 媒体落盘（图片/文件/视频/表情）：仅当 provider 提供了 media（URL/二进制）才保存
  let mediaRel = '';
  if (msg.media && (msg.media.url || msg.media.buffer) && !Storage.isChat(msg.kind)) {
    mediaRel = await storage.saveMedia({
      channelName: channel.name,
      id: record.id,
      media: msg.media,
      kind: msg.kind,
      text: msg.text || '',
    });
    if (mediaRel) {
      storage.setMedia(record.id, mediaRel);
      record.media = mediaRel;
    }
  }
  ws.broadcast({ type: 'message', record });

  // 归档回执：收到消息后，按会话对象聚合类型与数量，去抖后自动回复发送者
  receipt.handle(channel, msg, config.ingest.auto_reply_receipt);

  // 纯文本 / 语音 → 聊天.xlsx
  if (Storage.isChat(msg.kind)) {
    await handleChatMessage(channel, msg, record);
    return;
  }

  // 其他平台类型 → 优先用平台判定类型归类（减少 AI），否则回落 AI 语义分类
  const decision = resolveClassification(msg.kind);
  if (decision.source === 'platform') {
    const updated = storage.reclassify(record.id, decision.category, decision.sub);
    if (updated) ws.broadcast({ type: 'reclassify', record: updated });
    return;
  }
  classifyText(msg.text || '')
    .then((cat) => {
      if (!cat) return;
      const updated = storage.reclassify(record.id, cat.category, cat.sub);
      if (updated) ws.broadcast({ type: 'reclassify', record: updated });
    })
    .catch(() => {});
}

// 纯文本 / 语音：归入聊天.xlsx（不进分类文件夹）
//   语音：先保存音频，再取社交端转写文字；社交端无转写则用配置的 STT 端点 AI 补转
//   分类：用 AI 对（转写后）文字做语义分类，写入 聊天.xlsx 的「分类」列
async function handleChatMessage(channel, msg, record) {
  let text = msg.text || '';
  let voiceRel = '';
  let category = '未分类';
  let sub = '';

  if (msg.kind === 'voice') {
    // 语音默认归入「语音」；若社交端已给转写且配置了 AI，则进一步做语义细分
    category = '语音';
    // 1) 保存音频（若 provider 能提供 url / buffer）
    if (msg.media && (msg.media.url || msg.media.buffer)) {
      voiceRel = await storage.saveVoiceFile({ channelName: channel.name, media: msg.media });
    }
    // 2) 转写：社交端已给文字就用；否则用 AI 补转（需音频）
    let transcript = text;
    if (!transcript && voiceRel) transcript = await transcribeVoice(voiceRel);
    text = transcript || '（语音，暂无可读转写）';
    // 3) 分类：有转写文字则尝试 AI 语义细分（失败/未配置则保留「语音」）
    if (transcript) {
      const cat = await classifyText(text).catch(() => null);
      if (cat) {
        category = cat.category;
        sub = cat.sub;
      }
    }
  } else {
    // 纯文本归类，优先级：表情 > 单独一条网址 > AI 语义
    // ① 纯表情文本（如「[裂开]」）入库时已被规整为 emoji 类型，这里同步归入「表情」；
    // ② 整条消息就是一个网址 → 归入「收藏网址」，按域名做子分类，并异步抓取网页快照；
    // ③ 其余纯文本：恒归入「文本消息」大类，AI 判定作为其下的子分类。
    if (isPureEmojiText(text)) {
      const cat = textClassification(null, { emoji: true });
      category = cat.category;
      sub = cat.sub;
    } else if (isPureUrl(text)) {
      category = LINK_CATEGORY;
      sub = urlDomain(text);
    } else {
      const cat = textClassification(await classifyText(text).catch(() => null), { emoji: false });
      category = cat.category;
      sub = cat.sub;
    }
  }

  const updated = storage.reclassify(record.id, category, sub);
  if (voiceRel) storage.setVoice(record.id, voiceRel);
  await storage.appendChatRow({
    channelName: channel.name,
    row: { ts: updated?.ts || record.ts, channel: channel.name, peer: msg.peer, category, sub, text, voice: voiceRel },
  });
  ws.broadcast({ type: 'reclassify', record: { ...(updated || record), category, sub, voice: voiceRel } });

  // 正文里出现 http(s) 链接就归档快照（异步，不阻塞入库与回执）
  captureLinkSnapshots(record, text).catch((e) =>
    console.error('[ClawVault] 链接快照任务异常:', e?.message || e),
  );
}

function handleStatus() {
  ws.broadcast({ type: 'channels', channels: manager.listChannels() });
}

const manager = new ChannelManager({ dataDir: config.dataDir, onMessage: handleMessage, onStatus: handleStatus });
manager.resumeAll();

const app = express();

// ---- 飞牛统一网关适配 ----
// 网关把公开路径 /app/clawvault/** 原样转发到本服务的 Unix Socket，
// 因此收到的 req.url 带前缀。这里在最前面剥离前缀，让下游所有既有路由
// （/api/**、静态资源、SPA 兜底）无需改动即可复用；非网关模式下该中间件为空操作。
if (config.gatewayPrefix) {
  const prefix = config.gatewayPrefix;
  app.use((req, res, next) => {
    if (req.url === prefix) {
      // 访问 /app/clawvault（无尾斜杠）时重定向到带斜杠版本，
      // 保证前端相对资源与 SPA 路由的基准路径正确。
      res.redirect(301, prefix + '/');
      return;
    }
    if (req.url.startsWith(prefix + '/')) req.url = req.url.slice(prefix.length) || '/';
    next();
  });
}

// 网关注入的可信身份上下文（登录态已由飞牛校验）。
// 官方要求：不得信任客户端自带的用户 ID，只认这三个 Header。
app.use((req, res, next) => {
  const uid = req.headers['x-trim-userid'];
  req.fnUser = uid
    ? {
        uid: String(uid),
        username: req.headers['x-trim-username'] ? String(req.headers['x-trim-username']) : '',
        isAdmin: req.headers['x-trim-isadmin'] === 'true',
      }
    : null;
  next();
});

// 纵深防御（OPS-P0-02）：生产态（gatewayPrefix 已配置）要求所有 /api 请求携带网关注入身份头，
// 直连 Unix Socket（无网关头）视为未授权，返回 401。网关注入头对登录用户恒存在；
// 例外：/api/health（fnOS 存活探针）、/api/about（品牌页，无敏感数据）、/api/inbound（外部 webhook 开放）。
const _gatewayExempt = ['/api/health', '/api/about', '/api/inbound'];
app.use('/api', (req, res, next) => {
  if (!config.gatewayPrefix) return next(); // 开发 / 直连模式放行
  // 注意：app.use('/api') 挂载下 req.path 不含 /api 前缀，需用 baseUrl+path 还原完整路径
  const full = req.baseUrl + req.path;
  if (_gatewayExempt.some((p) => full.startsWith(p))) return next();
  if (req.fnUser) return next();
  return res.status(401).json({ error: '未携带网关身份，拒绝访问' });
});

app.use(express.json({ limit: '2mb' }));
// 全局限流：/api 下每分钟每用户（或 IP）最多 300 次请求
app.use('/api', rateLimit({ windowMs: 60_000, max: 300 }));

if (config.demoMode) startDemoMode();

// 写操作权限门禁：POST/PUT/DELETE/PATCH 到 settings/channels/messages 需管理员
// （/api/inbound 等外部 webhook 不在此列，保持开放）
const _protectedPrefix = ['/api/settings', '/api/channels', '/api/messages'];
app.use((req, res, next) => {
  if (!['POST', 'PUT', 'DELETE', 'PATCH'].includes(req.method)) return next();
  if (!_protectedPrefix.some((p) => req.path.startsWith(p))) return next();
  return requireAdmin(req, res, next);
});

app.use('/api/channels', createChannelsRouter({ manager, storage }));
app.use('/api/messages', createMessagesRouter({ storage, ws }));
app.use('/api/folders', createFoldersRouter({ storage }));
app.use('/api/settings', createSettingsRouter({ config, storage, saveSettings }));
app.use('/api/chats', createChatsRouter({ storage }));
app.use('/api/voice', createVoiceRouter({ storage }));
app.use('/api/media', createMediaRouter({ storage }));
app.use('/api/about', createAboutRouter({ storage }));
app.use('/api/links', createLinksRouter({ storage }));
app.use('/api/health', createHealthRouter({ storage, manager, config, startedAt }));

// 已注册的 bot 接入类型（前端"添加通道"表单据此渲染）
app.get('/api/providers', (req, res) => res.json(listProviders()));

// Webhook 类 Provider 入站：外部系统 POST 到这里把消息推入归档
app.post('/api/inbound/:id/:sub?', async (req, res) => {
  try {
    const result = await manager.inbound(req.params.id, req.body || {}, req.headers);
    if (result.verify) return res.json({ challenge: result.verify }); // Slack 订阅验证回显
    res.json(result);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// 部署态 cwd 是应用根（如 /vol1/@appcenter/clawvault），不是 backend/src，
// 因此不能用 process.cwd() 找 public；改用本模块文件位置推导。
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.resolve(__dirname, '..', 'public');
if (fs.existsSync(publicDir)) {
  app.use(express.static(publicDir));
  app.get('*', (req, res) => res.sendFile(path.join(publicDir, 'index.html')));
} else {
  app.get('/', (req, res) =>
    res.send('ClawVault backend running. Build the frontend (npm run build in app/frontend) to enable the Web UI.'),
  );
}

const server = http.createServer(app);

// WebSocket 升级请求不经过 express 中间件，req.url 仍带网关前缀，
// 因此这里要用「前缀 + /ws」注册，与前端连接地址保持一致。
// 生产态要求 WebSocket 升级也携带网关身份头（纵深防御 OPS-P0-02）
ws.requireGatewayAuth = !!config.gatewayPrefix;
ws.attach(server, `${config.gatewayPrefix}/ws`);

// 是否已成功进入监听态（用于区分启动期 / 运行期异常）
let listening = false;

function onListening() {
  listening = true;
  const where = config.socketPath ? `unix:${config.socketPath}` : `http://0.0.0.0:${config.port}`;
  const via = config.gatewayPrefix ? `  (网关前缀: ${config.gatewayPrefix})` : '';
  console.log(`ClawVault 已启动: ${where}${via}  归档根: ${config.archiveRoot}`);
  if (config.demoMode) console.log('[演示模式] 已启用，将定时注入样本消息用于验证');
}

if (config.socketPath) {
  // 统一网关模式：监听 Unix Socket。
  // 上次异常退出可能残留 socket 文件，导致 EADDRINUSE，先清理。
  try {
    if (fs.existsSync(config.socketPath)) fs.unlinkSync(config.socketPath);
  } catch (e) {
    console.error(`清理残留 socket 失败: ${e.message}`);
  }
  fs.mkdirSync(path.dirname(config.socketPath), { recursive: true });
  // P0-01（可选加固，用户已确认执行）：把 socket 所在目录（即应用控制目录）收为 0o700，
  // 仅属主 clawvault 可进入。飞牛网关以 root 运行、凭 CAP_DAC_OVERRIDE 可穿透 DAC，
  // 故不受影响；其余本地账号（含近 root 权限的 admin）/ 容器被挡，进一步收敛横向面。
  try {
    fs.chmodSync(path.dirname(config.socketPath), 0o700);
  } catch (e) {
    console.error(`设置 socket 父目录权限失败: ${e.message}`);
  }
  server.listen(config.socketPath, () => {
    // 飞牛网关链路：浏览器 → nginx(www-data) → trim_http_cgi(以 root 运行) → 本 socket。
    // 真正连入本 socket 的对端是 root 身份的网关进程，它具备 CAP_DAC_OVERRIDE，
    // 因此把 socket 收到 0o600 即可放行网关、同时阻断本机其他任何本地账号/容器
    // （含普通 admin、被攻破的第三方应用）直接 curl --unix-socket 越权读取聊天归档。
    // 这是 P0-01 的真实修复点：应用层无法依赖网关身份头做鉴权（见上方 x-trim-* 中间件，
    // 那些 Header 由飞牛网关注入、且 0o600 已挡住直连伪造），故以 OS 层 DAC 为唯一防线。
    // 旧版 0o666 等于把私有聊天归档向全机开放，属 P0 高危。
    // 注：Node 无 getPeerCredentials，无法在应用层按对端 uid 二次校验，0o600 即为全部防线。
    try {
      fs.chmodSync(config.socketPath, 0o600);
    } catch (e) {
      console.error(`设置 socket 权限失败: ${e.message}`);
    }
    onListening();
  });

  // 退出时清理 socket 文件，避免下次启动 EADDRINUSE
  const cleanup = () => {
    try {
      server.close();
      if (fs.existsSync(config.socketPath)) fs.unlinkSync(config.socketPath);
    } catch {
      /* 退出路径上的清理失败无需处理 */
    }
    process.exit(0);
  };
  process.on('SIGTERM', cleanup);
  process.on('SIGINT', cleanup);
} else {
  server.listen(config.port, onListening);
}

// 全局未捕获异常：区分启动期与运行期。
// 启动期（还没 listen 成功）出错说明服务根本起不来，退出让 cmd/main 走重启逻辑；
// 运行期出错通常来自某个 provider 的轮询回调，直接 exit 会让整个应用在飞牛里显示「已停止」，
// 代价远大于局部功能失效——因此只记录堆栈、保持进程存活。
process.on('uncaughtException', (err) => {
  console.error('[ClawVault] 未捕获异常:', err?.message || err);
  console.error(err?.stack || '');
  if (!listening) {
    console.error('[ClawVault] 启动阶段异常，退出等待重启');
    process.exit(1);
  }
});
process.on('unhandledRejection', (reason) => {
  console.error('[ClawVault] 未处理的 Promise 拒绝:', reason?.message || reason);
});

// 演示模式：Mock 一个 bot 通道，定时注入样本消息，验证「接收→分类→落盘→UI」全链路
function startDemoMode() {
  const demoChannel = { id: 'demo', name: '演示Bot' };
  // 覆盖文本(进聊天.xlsx) / 语音(社交端已转写，进聊天.xlsx) / 图片(平台类型归类) 三类，演示全链路
  const samples = [
    { kind: 'text', text: '帮我总结一下今天的项目进度，重点是后端接口联调和前端联调' },
    { kind: 'text', text: '推荐几部适合周末看的硬核科幻电影' },
    { kind: 'voice', text: '语音转写：提醒我明早九点跟客户开会，记得带合同' },
    { kind: 'text', text: '记一下：下周三是妈妈生日，别忘了买礼物和订蛋糕' },
    { kind: 'image', text: '这是今天评审用的架构设计图' },
    { kind: 'text', text: '帮我写一段读取 CSV 并画折线图的 Python 脚本' },
    { kind: 'text', text: '把这次团建方案整理一下：周六上午爬山，下午剧本杀' },
    { kind: 'text', text: '[裂开][旺柴] 这需求又变了' },
  ];
  let i = 0;
  const tick = () => {
    const s = samples[i % samples.length];
    i += 1;
    handleMessage(demoChannel, { peer: 'demo-user', text: s.text, kind: s.kind, contextToken: '', ts: Date.now() });
  };
  tick();
  setInterval(tick, 7000);
}
