# 贡献指南（CONTRIBUTING）

感谢你考虑为 **ClawVault（爪匣）** 做贡献！这是一份轻量约定，照做即可。

## 开发环境

后端（Node 18+，需原生编译 better-sqlite3）：

```bash
cd app/backend
npm install
ARCHIVE_ROOT=./archive DATA_DIR=./data PORT=6789 npm start
```

前端（另开终端，热更新，默认代理到 `:6789`）：

```bash
cd app/frontend
npm install
npm run dev
```

自托管一键跑（含镜像构建）：

```bash
PORT=6789 ARCHIVE_ROOT=/vol1/@app/ClawVault DEMO_MODE=false docker compose up -d --build
```

## 测试

后端用 Node 内置测试运行器（零额外框架）：

```bash
cd app/backend
node --test tests/*.test.js
```

- 测试覆盖：`classify`（分类映射/AI 解析）、`storage`（SQLite+xlsx 落盘）、`filedrop`（新增 Provider）、`vault`（凭据加密 + ChannelManager 持久化加密往返）。
- 新增逻辑请尽量补单测，尤其 Provider 与加密相关代码。

## 新增一个 Provider（可插拔接入）

1. 在 `app/backend/src/providers/` 新建 `<name>.js`，继承 `Provider` 基类（`providers/base.js`），实现 `startLogin / resume / start / stop / send / handleInbound`。
2. 在 `app/backend/src/providers/index.js` 注册：把类加入 `getProviderClass` 的 `switch`，并在 `PROVIDERS` 加元数据（含 `configFields`，Web UI 会据此自动渲染「添加通道」表单，**无需改前端**）。
3. 需要外部依赖时，把读取与网络调用做成**可注入**，便于离线单测（参考 `filedrop.js`）。
4. 补 `tests/<name>.test.js`。

## 凭据安全

- 通道凭据（token / secret）落盘到 `channels.json` 时由 `src/vault.js` 做 **AES-256-GCM** 加密。
- 密钥优先级：`CLV_MASTER_KEY` 环境变量 > `data_dir/.clvkey`（首次自动生成，权限 600）。
- 列表接口已对 `password` 类型字段脱敏；**不要把明文密钥写进代码或提交**。

## 提交规范

- 分支：`master` 受保护，请用特性分支发起 PR。
- Commit message 推荐 `feat:` / `fix:` / `docs:` / `refactor:` 前缀，简短说明「做了什么、为什么」。
- 不要提交 `node_modules`、构建产物、本地 `archive/`、`data/` 目录（已被 `.gitignore` 覆盖）。

## 打包 fpk（飞牛 fnOS 安装包）

`fpk` 是 **双层 gzip tar**：外层根 7 项（`manifest` / `cmd/` / `wizard/` / `config/` / `ICON.PNG` / `ICON_256.PNG` / `app.tgz`）+ 内层 `app.tgz`（打包整个 `app/` 目录）。项目布局遵循 fnpack：`desktop_uidir=ui` 对应 `app/ui/`，桌面 UI 与后端/前端一起进 `app.tgz`。

本地打包（无需 `fnpack`）：

```bash
cd ClawVault
VER=$(grep '^version=' manifest | cut -d= -f2)

# 1) 内层：把 app/ 打成 app.tgz（顶层为 app/）
tar -czf app.tgz app

# 2) 外层：固定 7+ 顶层条目（app/ 不直接出现在外层）
tar -czf "dist-fpk/clawvault_${VER}_x86_64.fpk" \
  manifest cmd wizard config ICON.PNG ICON_256.PNG app.tgz \
  Dockerfile docker-compose.yml LICENSE README.md CONTRIBUTING.md
```

发布请走 GitHub Release（附带 fpk 资源），版本号与 `manifest` 中 `version` 保持一致。
