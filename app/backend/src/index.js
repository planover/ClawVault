import express from 'express';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import config from './config.js';
import { ChannelManager } from './manager.js';
import { Storage } from './storage.js';
import { classifyText, resolveClassification } from './classify.js';
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
import { ReceiptService } from './receipt.js';

// ---- 设置持久化（覆盖默认配置） ----
function loadSettings() {
  const p = path.join(config.dataDir, 'settings.json');
  try {
    const s = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (s.ai) Object.assign(config.ai, s.ai);
    if (s.ingest) Object.assign(config.ingest, s.ingest);
    if (s.classification) Object.assign(config.classification, s.classification);
    if (s.archiveRoot) config.archiveRoot = s.archiveRoot;
  } catch {
    /* 无持久化设置则用默认 */
  }
  config.ai.enabled = Boolean(config.ai.apiKey) && config.classification.enabled !== false;
}

function saveSettings() {
  const p = path.join(config.dataDir, 'settings.json');
  fs.writeFileSync(
    p,
    JSON.stringify(
      {
        ai: config.ai,
        ingest: config.ingest,
        classification: config.classification,
        archiveRoot: config.archiveRoot,
      },
      null,
      2,
    ),
  );
}

loadSettings();

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
const ws = new WSBroadcaster();
// 归档回执服务（收到消息后自动回复发送者，详见 receipt.js）
const receipt = new ReceiptService();

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
    // 纯文本：AI 语义分类
    const cat = await classifyText(text).catch(() => null);
    if (cat) {
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

app.use(express.json());

if (config.demoMode) startDemoMode();

app.use('/api/channels', createChannelsRouter({ manager, storage }));
app.use('/api/messages', createMessagesRouter({ storage, ws }));
app.use('/api/folders', createFoldersRouter({ storage }));
app.use('/api/settings', createSettingsRouter({ config, storage, saveSettings }));
app.use('/api/chats', createChatsRouter({ storage }));
app.use('/api/voice', createVoiceRouter({ storage }));
app.use('/api/media', createMediaRouter({ storage }));
app.use('/api/about', createAboutRouter({ storage }));
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
  server.listen(config.socketPath, () => {
    // 飞牛网关进程与应用运行用户不同，需放开 socket 访问位才能转发进来。
    try {
      fs.chmodSync(config.socketPath, 0o666);
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
