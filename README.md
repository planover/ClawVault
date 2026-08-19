# ClawVault（爪匣）

> 把你在微信 / Telegram / 飞书 / 钉钉 / 企业微信 / Discord / Slack 等各平台与 **bot** 的对话，用 **AI 自动分类** 后归档到 **飞牛（fnOS）** 文件系统的不同文件夹，并在 Web 界面中浏览、检索与管理。

采用 **可插拔多 Provider 架构**：微信 ClawBot 只是其中一种接入适配器，新增 Bot 平台只需实现一个 `Provider` 子类，数据始终留在你自己的飞牛，不上传第三方。

---

## 功能特性

- **多 Bot 接入（可插拔 Provider）**：内置 **微信 ClawBot（iLink）、通用 Webhook、Telegram、钉钉/飞书/企业微信、Discord/Slack** 五种接入；微信只是其中一种，新增平台只需实现 `Provider` 子类。
- **多通道**：每个 bot 是一个独立通道，互相隔离，可同时归档你与「众多 bot」的对话。
- **只跟 bot 聊**：仅接收「你 ↔ bot」的对话，不处理真人好友、不支持群聊，天然满足「不加好友、只跟 bot 聊」的纯净归档场景。
- **AI 自动分类 + 平台类型优先**：图片 / 文件 / 视频 / 链接 / 表情 / 位置 / 名片 / 指令等**平台能直接判定的消息类型，直接按类型归类，不消耗 AI 调用**；纯文本才交给 AI 做语义分类（设置里可关闭该优先策略）。归入已有或新建的分类文件夹（支持二级分类 `主分类/子分类`），可人工修正。
- **聊天归档（纯文本 / 语音）→ 聊天.xlsx**：纯文本与语音消息**不再散落成 Markdown**，而是按**每通道一个 `聊天.xlsx`** 汇总成一张聊天表（列：时间 / 通道 / 分类 / 子分类 / 会话 / 文字 / 语音），可直接用 Excel / 飞牛表格打开浏览。语音消息会**借助社交软件端转写文字**，社交端无转写时可用配置的 STT 端点 AI 补转，音频文件同时落盘并可在 `语音` 列一键播放。
- **落盘到飞牛**：图片 / 文件 / 视频 / 链接等**非聊天类**消息按 `[归档根]/[通道]/[分类]/[子分类]/` 自动存入飞牛文件系统，每条为可读 Markdown；并提供 SQLite 全文检索。聊天类（纯文本/语音）统一在 `[归档根]/[通道]/聊天.xlsx` 与 `[归档根]/[通道]/语音/`。
- **Web 管理**：在飞牛内嵌浏览器查看分类树、对话流、消息详情，WebSocket 实时刷新。
- **默认不回复**：飞牛只接收并归档，不做主动回复（保持「纯归档」定位）。

---

## 架构

```
 微信 / Telegram / 飞书 / 钉钉 / 企微 / Discord / Slack / 任意HTTP
   (你 ↔ bot)  ──各平台协议──▶  ┌──────────────────────────┐
                          │  ClawVault             │
                          │  接入层: 多 Provider 适配器 │
                          │   (wechat/telegram/webhook/…) │
                          │       │                   │
                          │   AI 自动分类模块          │
                          │       │                   │
                          │   存储层 (SQLite+文件)     │
                          │       │                   │
                          │   Web UI (Vue) + API/WS   │
                          └───────────┬──────────────┘
                                      │
                              飞牛文件系统
                  [归档根]/[通道]/[分类]/[子分类]/消息.md
```

技术栈：Node.js + Express + WebSocket + better-sqlite3（后端）；Vue 3 + Vite（前端）。

---

## 目录结构

```
ClawVault/
├── manifest              # fnOS 应用元数据（应用中心规范）
├── ICON.PNG / ICON_256.PNG
├── cmd/                  # fnOS 生命周期脚本（start/stop/status）
├── wizard/               # 安装向导
├── config/               # 权限、资源、能力声明
│   ├── privilege         # 运行身份（package 专用用户）
│   └── resource          # data-share / api-scope
├── scripts/              # 构建脚本
│   ├── build-fpk.sh      # 打 fpk 包
│   └── prepare-runtime.sh# 下载内置 Node + better-sqlite3 预编译 + ffmpeg
├── app/
│   ├── backend/          # Node 后端（多 Provider 接入 / 存储 / 分类 / API）
│   │   └── src/providers/# 各 Bot 平台适配器（新增平台在此加文件）
│   ├── frontend/         # Vue 前端
│   ├── ui/               # 飞牛桌面入口配置
│   └── runtime/          # 内置 Linux 运行时（Node / better-sqlite3 / ffmpeg）
└── README.md
```

---

## 快速开始

### 方式一：飞牛 fnOS 应用中心（推荐）

ClawVault 已改造为**原生 fnOS 应用**：内置 Node.js 运行时，无需 Docker，在飞牛桌面以**独立窗口**打开（非浏览器新标签）。

#### 离线安装

1. 下载本仓库 Releases 中的 `clawvault_<版本>_x86_64.fpk`。
2. 飞牛「应用中心 → 离线安装」上传该 `.fpk`。
3. 安装完成后，点击桌面「ClawVault（爪匣）」图标，即可在独立窗口内打开。

#### 从源码构建 fpk

```bash
# 1. 准备 Linux 运行时（Node v22.23.2 + better-sqlite3 预编译 + 可选 ffmpeg）
#    脚本已做国内镜像适配；如本地网络受限，可手动把二进制放到 .dl/ 目录
bash scripts/prepare-runtime.sh

# 2. 构建前端 + 后端 + 打包 fpk
bash scripts/build-fpk.sh --check

# 产物：dist-fpk/clawvault_1.0.21_x86_64.fpk
```

> 构建说明：
> - 前端使用 `base=/app/clawvault/` 发布构建，保证资源路径与飞牛统一网关 `/app/clawvault` 一致。
> - 后端依赖使用 `npm install --omit=dev --ignore-scripts`，并在 `app/runtime/` 中注入 Linux 原生 `better_sqlite3.node`，避免在 Windows/macOS 构建机拉错平台二进制。
> - 随包在 `app/runtime/sqlite3-pristine/better_sqlite3.node` 额外备份一份经校验的 Linux ELF；`cmd/main` 启动前若发现 `node_modules` 内的 `.node` 被污染（如旧缓存残留），会自动从备份恢复，避免 `invalid ELF header` 启动失败。
> - `ffmpeg` 为可选，仅用于 AMR 语音转 MP3；缺失时 SILK→WAV 仍可用纯 JS 解码，AMR 会保留原文件但不可播放。
> - `cmd/main` 启动时会先解析真实应用根目录：优先用 `TRIM_APPDEST`，若未注入或 `runtime/node` 不在 `/var/apps/clawvault` 下，则自动探测 `/vol1/@appcenter/clawvault`（fnOS 实际解压目录）。可避免「控制目录 /var/apps/clawvault 下找不到内置 Node 运行时」的启动失败。

### 重要：升级前请先彻底清理旧残留

飞牛应用中心会按 **fpk 文件名** 缓存安装包。若之前装过同名/旧版本但没清干净 `@appcenter` 残留目录，可能仍跑旧代码（表现为启动日志里版本号与已装版本不符，或依旧 `invalid ELF header`）。请严格按序：

```bash
# 1. 飞牛应用中心卸载 ClawVault
# 2. SSH 到 NAS 删除所有残留（数据盘若是 /vol2 等请对应修改）
sudo rm -rf /var/apps/clawvault /vol1/@appcenter/clawvault
# 3. 重新「应用中心 → 离线安装」上传新 fpk
```

启动成功后，`main.log` 首行会打印包版本号，例如 `ClawVault v1.0.21 已启动 (pid ...)`，可据此确认 NAS 跑的是新包。

### 方式二：本地开发

```bash
# 后端（直接 Node 启动，走 TCP 端口模式）
cd app/backend && npm install
ARCHIVE_ROOT=./archive DATA_DIR=./data PORT=6789 npm start

# 前端（另开终端，热更新）
cd app/frontend && npm install && npm run dev
# 前端默认代理到 http://localhost:6789
```

---

## 飞牛安装后配置

安装完成并启动后，在独立窗口中打开「设置」页：

1. **归档根目录**：默认指向 `TRIM_DATA_SHARE_PATHS` 中的第一个共享目录，可在设置中修改；建议指向一个已存在的飞牛共享文件夹。
2. **AI 分类接口**（可选）：填写 `API Key`、`Base URL`、`Model`；留空则消息按平台类型或「未分类」归档。
3. **语音转写 STT**（可选）：兼容 OpenAI `/v1/audio/transcriptions` 的端点；未配置时依赖社交端自带转写。
4. **通道管理**：进入「通道管理」添加通道并绑定你的 bot；支持微信 ClawBot、Telegram、Webhook、钉钉/飞书/企微、Discord/Slack 等。

> 首次打开时若提示「无法启用 clawvault / 本地应用启动失败」：
> - 若 `main.log` 出现 `bad interpreter` 或 `^M` 相关错误，是 `cmd/main` 换行符为 CRLF，需以 LF 重新打包。
> - 若 `main.log` 出现 `better_sqlite3.node: invalid ELF header`，是打包时误将 Windows 版原生模块混入 fpk，需重新运行 `bash scripts/build-fpk.sh --check`，确保注入的是 Linux ELF。
> - 本仓库构建脚本已通过 `.gitattributes` 强制 LF、并在打包前清理并重新注入 Linux 原生二进制。

---

## 数据目录结构

所有数据都落在 `ARCHIVE_ROOT`（默认 `/archive`，fnOS 下建议 `/vol1/@app/ClawVault`）。结构如下：

```
<归档根>/
├── <通道A>/                     # 每个 bot 通道一个目录
│   ├── 聊天.xlsx                # 该通道纯文本/语音汇总表（Web UI 可下载）
│   ├── 语音/                    # 语音音频文件（Web UI 可在线播放）
│   │   └── <时间戳>-<随机>.mp3
│   ├── 图片/                    # 平台判定的图片类（按分类再分子目录）
│   │   └── <子分类>/
│   │       └── <时间戳>.md
│   ├── 文件/
│   ├── 视频/
│   └── …（其他平台类型分类文件夹）
├── <通道B>/
└── …
```

- **聊天类（纯文本 / 语音）**：集中在每通道一个的 `聊天.xlsx`，不散落成 Markdown；并额外在 `语音/` 存音频。
- **非聊天类（图片 / 文件 / 视频 / 链接 / 表情 …）**：按「平台判定类型 → 分类 → 子分类」落 Markdown，便于在文件系统直接浏览。
- **索引**：`DATA_DIR`（默认 `/data`）下 `archive.db`（SQLite）保存全部消息元数据与全文检索索引；`channels.json` 保存通道配置；`settings.json` 保存设置。这些都在你自己的飞牛上，不上传任何第三方。

---

## 配置

在 Web 界面「设置」中配置，或设置环境变量：

| 配置项 | 环境变量 | 说明 |
|--------|----------|------|
| AI 分类启用 | — | 开关；关闭则分类退化为「未分类」 |
| 优先平台类型 | — | 默认开；图片/文件/语音等按平台判定归类，减少 AI 调用 |
| API Key | `AI_API_KEY` | 兼容 Anthropic 格式的接口密钥 |
| Base URL | `AI_BASE_URL` | 默认 `https://api.anthropic.com`，可填代理 |
| 模型 | `AI_MODEL` | 如 `claude-sonnet-4-5`、`gpt-5` 等 |
| 语音转写 STT URL | `STT_URL` | 可选；兼容 OpenAI 的 `/v1/audio/transcriptions` 端点，社交端无转写时 AI 补转语音 |
| STT 模型 | `STT_MODEL` | 默认 `whisper-1` |
| 归档根目录 | `ARCHIVE_ROOT` | 对话落盘根目录 |
| 白名单 | 设置页 | 仅归档名单内的联系人（留空 = 全部 bot） |
| 演示模式 | `DEMO_MODE=true` | 注入样本消息用于验证 |

分类由 AI 返回 JSON `{ "category": "...", "sub": "..." }` 决定；未配置 AI 时统一归入「未分类」。

> 设置页提供 **「测试连接」** 按钮：填入 API Key / Base URL / 模型后点击，会用一条样例消息真实地调用一次 `/v1/messages`，返回是否成功、模型名、耗时与样例分类结果，便于在保存前确认接入可用（无需真实消息流入）。

### 分类优先级：优先用平台类型，减少 AI 调用

> 社交软件/平台通常已经知道一条消息是「图片 / 语音 / 视频 / 文件 / 链接 …」，这种**类型信息不需要 AI 再来猜**。ClawVault 默认先采用平台判定的消息类型直接归类，只为纯文本调用 AI 做语义分类——既更准，又省 token。

判定链路（见 `app/backend/src/classify.js` 的 `resolveClassification`）：

1. 开启「优先平台类型」且消息带有平台类型 `kind` → 直接映射为分类（`source = 'platform'`），**不调用 AI**；
2. 纯文本 / 平台无类型信息 / 关闭该开关 → 回落到 AI 语义分类（`source = 'ai'`）。

`kind` → 分类的默认映射（各 Provider 在收到消息时自动判定并透传）：

| kind（平台类型） | 归类 | kind（平台类型） | 归类 |
|------------------|------|------------------|------|
| `image` / `photo` / `picture` | 图片 | `link` / `url` | 链接 |
| `voice`（语音留言） | **聊天.xlsx** | `bot_command` / `command` | 指令 |
| `audio`（音乐/音频文件） | 语音（文件夹） | `system` / `notification` | 系统 |
| `video` / `short_video` | 视频 | `system` / `notification` | 系统 |
| `file` / `document` | 文件 | `text` / `plain` | 交给 AI |
| `sticker` / `emoji` / `gif` | 表情 | `location` | 位置 |
| `card` / `contact` | 名片 | — | — |

> 若你更想让 **所有** 消息（含图片/文件）都按「语义」归类，在设置里关闭「优先平台类型」即可——此时图片也会回落 AI（AI 仅拿到文本描述，分类效果通常不如平台类型可靠，且更费 token）。

### 聊天归档：纯文本 / 语音 → 聊天.xlsx

为方便直接在 Excel / 飞牛表格里翻阅对话，**纯文本与语音消息**不落 Markdown，而是汇总进**每个通道一个的 `聊天.xlsx`**（位于 `[归档根]/[通道]/聊天.xlsx`）。表格列：

| 列 | 含义 |
|----|------|
| 时间 | 消息时间（本地时区） |
| 通道 | 来自哪个 bot 通道 |
| 分类 | AI 语义分类（纯文本）或「语音」（语音） |
| 子分类 | 二级分类 |
| 会话 | 对方（peer） |
| 文字 | 消息正文 / 语音转写文字 |
| 语音 | 语音音频文件，点击「🎧 听音频」可跳转本地文件播放 |

**语音消息的处理**：

1. 先尝试取**社交软件端已提供的转写文字**（如微信语音自带的转写）；
2. 若社交端未提供、且在设置里配置了 **STT 转写端点**，则用 AI 补转（见下）；
3. 音频文件落盘到 `[归档根]/[通道]/语音/<时间戳>.mp3`，并在 `聊天.xlsx` 的「语音」列生成可点击的超链接；
4. 若既无社交端转写、也未配置 STT，则文字列显示「（语音，暂无可读转写）」，分类记为「语音」，音频仍照存。

> 图片 / 文件 / 视频 / 链接 / 表情 / 位置 / 名片 / 指令 / 系统 等**非聊天类**消息，仍按上节的平台类型优先策略归入分类文件夹（Markdown + SQLite），不进 `聊天.xlsx`。

**在 Web UI 中使用聊天归档与语音**：侧栏「聊天归档」列出每个通道的 `聊天.xlsx`，点击即可下载用 Excel / 飞牛表格打开；带 🎧 标记的通道表示含语音。点开任一条**语音消息**，详情面板会显示 `<audio>` 播放器，直接在线试听（音频由后端按消息 ID 流式返回，支持拖动进度）；若社交端无转写，文字列显示「（语音，暂无可读转写）」，音频仍照常可播。

**REST 速查**：`GET /api/chats` 列出各通道聊天归档（含下载 URL、行数、是否含语音）；`GET /api/chats/:channel/xlsx` 下载某通道 `聊天.xlsx`；`GET /api/voice/:id` 流式播放某条消息的语音。

### 语音 AI 补转（STT）配置

分类用的 LLM（Anthropic `/v1/messages`）不能处理音频，因此语音转写走一个**独立的、兼容 OpenAI 的 STT 端点**（如 Whisper）。在「设置 → 语音转写 STT URL」填入 `https://<你的端点>/v1/audio/transcriptions`，并填 `STT 模型`（默认 `whisper-1`）。留空则语音只存音频、不转写。该配置仅用于社交端无转写时的兜底。

---

## Bot 接入（多平台）

进入「通道管理 → 添加通道」，先选择 **Bot 类型**，再填对应配置：

| 类型 | 鉴权方式 | 关键配置 | 接入要点 |
|------|----------|----------|----------|
| 💬 微信 ClawBot | 扫码 | 无 | 点「扫码登录」用手机微信扫码确认；24h 到期自动重扫 |
| 🔗 通用 Webhook | HTTP | 出站地址(可选) | 外部系统 `POST /api/inbound/<通道ID>` 推送 `{text, peer}` 即可归档；最万能 |
| ✈️ Telegram | Token | `bot_token` | 填 BotFather Token，自动长轮询收消息 |
| 🏢 钉钉/飞书/企微 | Webhook | 平台 + 群机器人地址 + 密钥(可选) | 把平台「群机器人 Webhook」地址填到出站；入站用平台事件回调指向 `/api/inbound/<通道ID>` |
| 🤖 Discord/Slack | Webhook | 平台 + Incoming Webhook 地址 | 同 Webhook 思路；Slack 订阅验证会自动回显 `challenge` |
| 📁 本地文件投递 | 目录监控 | 监控目录（可选后缀/递归） | 零依赖；把 `.txt/.md` 等文本文件作为消息归档，适合本地 bot / 脚本把输出落盘即归档 |

**通用 Webhook 入站示例**（任意脚本/平台都能用，覆盖"其他 bot"）：

```bash
curl -X POST http://<飞牛IP>:6789/api/inbound/<通道ID> \
  -H 'content-type: application/json' \
  -d '{"peer":"alice","text":"这是一条来自任意 bot 的消息"}'

# 显式带类型可跳过 AI 直接归类（kind 见上文映射表）：图片/语音/视频/文件/链接/表情…
curl -X POST http://<飞牛IP>:6789/api/inbound/<通道ID> \
  -H 'content-type: application/json' \
  -d '{"peer":"alice","text":"产品截图.png","kind":"image"}'

# 语音：带 voice_url 会下载音频并存到 聊天.xlsx 的「语音」列（社交端无转写时用 STT 补转）
curl -X POST http://<飞牛IP>:6789/api/inbound/<通道ID> \
  -H 'content-type: application/json' \
  -d '{"peer":"bob","text":"","kind":"voice","voice_url":"https://files.example.com/voice_123.mp3"}'
```

该消息会立刻进入「接收 → 分类（优先平台类型，纯文本才走 AI）→ 落盘 → Web 实时刷新」链路。只要对方能发 HTTP，就能接入——无需为每个平台写专属代码。若不带 `kind`，系统会按是否有 `image/photo/file/voice/video` 等字段猜测类型，再不行则当作纯文本走 AI。纯文本与语音会写入该通道的 **`聊天.xlsx`**，其余类型按平台类型归入分类文件夹。

> 说明：微信 ClawBot API 只能接收「发给本 bot 的消息」，因此「多通道」是把你与多个微信 bot 对话分别接入归档的唯一可行方案；其他平台则可直接复用 Webhook / Token 适配器。

### 新增一种 Bot 平台（扩展指南）

只需在 `app/backend/src/providers/` 下新增一个 `Provider` 子类，并在 `index.js` 的 `PROVIDERS` 注册表中登记：

```js
import { Provider } from './base.js';
export class MyProvider extends Provider {
  async startLogin() { /* 拉起登录/置为已连接 */ }
  handleInbound(body, headers) { return { peer, text, ts, raw }; } // Webhook 类
  // 或 start(){ /* 长轮询/WS 收消息，收到后 this.channel.deliver(...) */ }
  async send(peer, text) { /* 可选：主动外发 */ }
}
```

---

## 演示模式

无需真实微信账号即可验证全链路：

```bash
DEMO_MODE=true PORT=6789 ARCHIVE_ROOT=./archive DATA_DIR=./data npm start --prefix app/backend
```

启动后会定时注入样本消息，自动走「接收 → AI 分类（若已配 AI）→ 落盘 → Web 实时刷新」流程，便于检查分类、文件夹与检索。

---

## REST API 速览

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/providers` | 已注册的 Bot 接入类型（前端表单据此渲染） |
| GET | `/api/channels` | 通道列表 |
| POST | `/api/channels` | 新建通道 `{name, providerType, providerConfig}` |
| DELETE | `/api/channels/:id` | 删除通道 |
| POST | `/api/channels/:id/login` | 登录/连接（微信=二维码，其他=即时连接） |
| POST | `/api/channels/:id/relogin` | 重新连接 |
| POST | `/api/inbound/:id` | Webhook 类入站：外部系统向此推送消息 |
| GET | `/api/messages` | 消息列表（支持 `channelId/category/sub/q/limit/offset`） |
| GET | `/api/messages/:id` | 消息详情 |
| POST | `/api/messages/:id/reclassify` | 重新分类 `{category,sub}` |
| GET | `/api/folders` | 分类文件夹树 |
| GET/POST | `/api/settings` | 读取/保存设置 |

WebSocket：`/ws` 推送 `{type:"message"|"reclassify"|"channels", ...}` 事件，用于实时刷新。

---

## 合规与说明

- 使用微信 ClawBot 需遵守《微信 ClawBot 功能使用条款》，仅用于合规的个人归档场景。
- 数据完全留在你自己的飞牛，后端不向任何第三方上报内容（AI 分类调用的是你自行配置的接口）。
- 本项目为第三方社区应用，与微信官方无隶属关系。

## 凭据安全

- 通道配置（含各平台 Token / Secret）持久化在 `DATA_DIR/channels.json`，**落盘前以 AES-256-GCM 加密**，不会以明文存储。
- 密钥优先级：环境变量 `CLV_MASTER_KEY`（推荐容器 / 生产，随 Secret 注入）> `DATA_DIR/.clvkey`（首次运行自动生成，权限 `600`）。
- 前端「通道管理」列表接口对 `password` 类型字段做脱敏展示（`••••••••`），磁盘与接口两层防护。
- 注意：`/api/inbound` 与 Web UI 默认无访问控制，建议仅在内网（飞牛）环境使用，对外暴露需自行加反向代理鉴权。

---

## 许可证

AGPL-3.0（见 `LICENSE`）。
