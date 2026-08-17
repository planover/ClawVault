#!/usr/bin/env bash
# ClawVault fpk 打包脚本（飞牛 fnOS 双层 gzip tarball，原生应用，无 Docker）
#
# 与原 Docker 版的区别：
#   - 不再打包 app/docker/；运行时由内置 Node（app/runtime/node）提供
#   - app.tgz 内容为 backend（含 node_modules + 构建后的 public）/ ui / runtime
#   - 前端构建产物（vite release，base=/app/clawvault/）落到 backend/public
#   - 原生模块 better-sqlite3 通过 scripts/prepare-runtime.sh 注入 linux 预编译
#
# 用法：
#   bash scripts/build-fpk.sh            # 构建到 dist-fpk/clawvault_<ver>_x86_64.fpk
#   bash scripts/build-fpk.sh --check    # 构建后额外模拟 fnOS 安装校验布局
#
# 注意：必须在 bash（Git Bash / Linux / macOS）下运行；Windows cmd 不行。
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR/.."
REPO="$(pwd)"

VER="$(grep '^version=' manifest | head -1 | cut -d= -f2)"
if [ -z "$VER" ]; then echo "✗ 无法从 manifest 读取 version" >&2; exit 1; fi

OUT_DIR="dist-fpk"
mkdir -p "$OUT_DIR"
FPK="$OUT_DIR/clawvault_${VER}_x86_64.fpk"

echo "==> 打包 ClawVault v$VER fpk（原生应用：内置 Node + 统一网关 /app/clawvault）"

# 1) cmd 脚本执行位（Windows 不保留 Unix 权限，强制补 755）
chmod +x cmd/main cmd/*.sh 2>/dev/null || true
echo "    ✓ cmd 脚本已确保 755"

# 2) 前端发布构建（base=/app/clawvault/）→ backend/public
echo "==> 构建前端 (vite release, base=/app/clawvault/)"
cd "$REPO/app/frontend"
rm -rf ../backend/public/assets ../backend/public/index.html 2>/dev/null || true
npm install --no-audit --no-fund
npm run build -- --config vite.release.config.mjs
cd "$REPO"
if [ ! -f app/backend/public/index.html ]; then
  echo "✗ 前端构建产物缺失: app/backend/public/index.html" >&2; exit 1
fi
echo "    ✓ 前端产物: app/backend/public/index.html"

# 3) 后端生产依赖（--ignore-scripts 跳过 better-sqlite3 平台预编译，稍后注入 linux 预编译）
echo "==> 安装后端生产依赖"
cd "$REPO/app/backend"
# 先清掉本机可能残留的 Windows/darwin 原生模块，避免 prepare-runtime.sh 看到文件存在就跳过
rm -rf node_modules/better-sqlite3/build/Release/better_sqlite3.node
npm install --omit=dev --ignore-scripts --no-audit --no-fund
cd "$REPO"

# 4) 准备原生运行时（内置 Node + better-sqlite3 linux 预编译 + 可选 ffmpeg）
bash "$SCRIPT_DIR/prepare-runtime.sh"

# 5) 内层 app.tgz：backend（node_modules + public）/ ui / runtime
#    不含 frontend 源码（已构建进 public）、不含 data/archive、不含测试与日志
[ -d app ] || { echo "✗ 缺少 app/ 目录" >&2; exit 1; }
rm -f app.tgz 2>/dev/null || true
( cd app && tar -czf ../app.tgz \
    --exclude='node_modules/.cache' \
    --exclude='*/test' --exclude='tests' \
    --exclude='data' --exclude='archive' --exclude='*.log' \
    backend ui runtime )
echo "    ✓ app.tgz ($(stat -c%s app.tgz) bytes)"

# 6) 外层 fpk：app.tgz 作为顶层文件之一（fnpack 规范）
rm -f "$FPK" 2>/dev/null || true
tar -czf "$FPK" \
  manifest cmd wizard config ICON.PNG ICON_256.PNG app.tgz \
  README.md CONTRIBUTING.md
echo "    ✓ fpk: $FPK ($(stat -c%s "$FPK") bytes)"

# 7) 可选：模拟 fnOS 安装校验布局
if [ "${1:-}" = "--check" ]; then
  SIM="$(pwd)/dist-fpk/_sim_check"
  rm -rf "$SIM" 2>/dev/null || true
  mkdir -p "$SIM"
  # 模拟 fnOS 第一步：解外层 fpk 到 ${TRIM_APPDEST}
  tar -xzf "$FPK" -C "$SIM"
  # 模拟 fnOS 第二步：解 app.tgz 直接铺平到应用根（无 app/ 中间层）
  tar -xzf "$SIM/app.tgz" -C "$SIM"
  ok=1
  for p in \
    manifest cmd/main config/privilege config/resource wizard/install \
    backend/src/index.js backend/node_modules/better-sqlite3/build/Release/better_sqlite3.node \
    backend/public/index.html ui/config runtime/node/bin/node; do
    if [ ! -e "$SIM/$p" ]; then echo "    ✗ 缺失 $p"; ok=0; fi
  done
  # 校验原生二进制确为 Linux ELF，避免把 Windows PE / HTML 错误页打包进 fpk
  for f in "$SIM/backend/node_modules/better-sqlite3/build/Release/better_sqlite3.node" "$SIM/runtime/node/bin/node"; do
    head="$(head -c 4 "$f" 2>/dev/null | od -An -tx1 | tr -d ' \n')" || true
    if [ "$head" != "7f454c46" ]; then echo "    ✗ $f 不是 Linux ELF（文件头 $head）"; ok=0; fi
  done
  # 原生应用不应再含 docker
  if [ -e "$SIM/docker" ]; then echo "    ✗ 不应包含 docker 目录（已改为原生）"; ok=0; fi
  # LICENSE 不应在外层根目录（避免触发 fnOS 自动英文协议步骤）
  if [ -e "$SIM/LICENSE" ]; then echo "    ✗ 外层不应有 LICENSE（会触发 fnOS 自动渲染英文协议步骤）"; ok=0; fi
  if [ ! -f "$SIM/app.tgz" ]; then echo "    ✗ 外层应含 app.tgz（fnpack 规范）"; ok=0; fi
  for f in "$SIM/cmd/main"; do
    if [ ! -x "$f" ]; then echo "    ✗ 无执行位 $f"; ok=0; fi
  done
  if [ "$ok" = "1" ]; then echo "    ✓ 安装布局校验通过（原生布局）"; else rm -rf "$SIM" 2>/dev/null || true; exit 1; fi
  rm -rf "$SIM" 2>/dev/null || true
fi

echo "==> 完成: $FPK"
