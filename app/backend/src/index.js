import express from 'express';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
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
const ws = new WSBroadcaster();

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
  });
  // 媒体落盘（图片/文件/视频/表情）：仅当 provider 提供了 media（URL/二进制）才保存
  let mediaRel = '';
  if (msg.media && (msg.media.url || msg.media.buffer) && !Storage.isChat(msg.kind)) {
    mediaRel = await storage.saveMedia({ channelName: channel.name, id: record.id, media: msg.media });
    if (mediaRel) {
      storage.setMedia(record.id, mediaRel);
      record.media = mediaRel;
    }
  }
  ws.broadcast({ type: 'message', record });

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
app.use(express.json());

if (config.demoMode) startDemoMode();

app.use('/api/channels', createChannelsRouter({ manager, storage }));
app.use('/api/messages', createMessagesRouter({ storage, ws }));
app.use('/api/folders', createFoldersRouter({ storage }));
app.use('/api/settings', createSettingsRouter({ config, storage, saveSettings }));
app.use('/api/chats', createChatsRouter({ storage }));
app.use('/api/voice', createVoiceRouter({ storage }));
app.use('/api/media', createMediaRouter({ storage }));
app.use('/api/about', createAboutRouter());
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

const publicDir = path.join(process.cwd(), 'public');
if (fs.existsSync(publicDir)) {
  app.use(express.static(publicDir));
  app.get('*', (req, res) => res.sendFile(path.join(publicDir, 'index.html')));
} else {
  app.get('/', (req, res) =>
    res.send('ClawVault backend running. Build the frontend (npm run build in app/frontend) to enable the Web UI.'),
  );
}

const server = http.createServer(app);
ws.attach(server);
server.listen(config.port, () => {
  console.log(`ClawVault 已启动: http://0.0.0.0:${config.port}  (归档根: ${config.archiveRoot})`);
  if (config.demoMode) console.log('[演示模式] 已启用，将定时注入样本消息用于验证');
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
