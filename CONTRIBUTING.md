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

fpk 本质是应用的 gzip tarball，文件名形如 `clawvault_<版本>_x86_64.fpk`。本地打包：

```bash
cd ClawVault
tar -czf clawvault_$(grep '^version=' manifest | cut -d= -f2)_x86_64.fpk \
  --exclude='.git' --exclude='node_modules' --exclude='*/node_modules' \
  --exclude='archive' --exclude='data' -C . .
```

发布请走 GitHub Release（附带 fpk 资源），版本号与 `manifest` 中 `version` 保持一致。
