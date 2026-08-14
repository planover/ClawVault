#!/usr/bin/env bash
# ClawVault fpk 打包脚本（飞牛 fnOS 双层 gzip tarball）
#
# fpk 结构（fnpack 规范）：
#   外层：manifest / cmd / wizard / config / ICON.PNG / ICON_256.PNG / app.tgz
#         + LICENSE / README.md / CONTRIBUTING.md
#   内层 app.tgz 顶层：backend / frontend / ui / docker（不含 app/ 包装层，
#                    fnOS 安装时会把 app.tgz 解到 install/app/，再包一层会错位）
#   fnOS 标准 Docker 应用布局：docker-compose 与 Dockerfile 都在 app/docker/ 下
#
# 用法：
#   bash scripts/build-fpk.sh            # 构建到 dist-fpk/clawvault_<ver>_x86_64.fpk
#   bash scripts/build-fpk.sh --check    # 构建后额外模拟 fnOS 安装校验布局
#
# 注意：必须在 bash（Git Bash / Linux / macOS）下运行；Windows cmd 不行。
set -euo pipefail

# 切到仓库根
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR/.."
REPO="$(pwd)"

# 读取版本
VER="$(grep '^version=' manifest | head -1 | cut -d= -f2)"
if [ -z "$VER" ]; then
  echo "✗ 无法从 manifest 读取 version" >&2
  exit 1
fi

OUT_DIR="dist-fpk"
mkdir -p "$OUT_DIR"
FPK="$OUT_DIR/clawvault_${VER}_x86_64.fpk"

echo "==> 打包 ClawVault v$VER fpk"

# 1) cmd 脚本执行位（Windows 不保留 Unix 权限，这里强制补，确保 fpk 内为 755）
chmod +x cmd/main cmd/*.sh 2>/dev/null || true
echo "    ✓ cmd 脚本已确保 755"

# 2) 内层 app.tgz：顶层 backend/frontend/ui/docker（排除 node_modules 与构建/运行产物，
#    NAS 上 docker build 会自行 npm install）
rm -f app.tgz 2>/dev/null || true
tar -czf app.tgz -C app \
  --exclude='node_modules' --exclude='*/node_modules' --exclude='*/node_modules/*' \
  --exclude='public' --exclude='dist' --exclude='data' --exclude='archive' \
  backend frontend ui docker
echo "    ✓ app.tgz 完成 ($(stat -c%s app.tgz) bytes)"

# 3) 外层 fpk：固定顶层条目（app/ 仅通过 app.tgz 间接存在；Dockerfile 与
#    docker-compose.yaml 已迁入 app/docker/，从外层移除）
rm -f "$FPK" 2>/dev/null || true
tar -czf "$FPK" \
  manifest cmd wizard config ICON.PNG ICON_256.PNG app.tgz \
  LICENSE README.md CONTRIBUTING.md
echo "    ✓ fpk: $FPK ($(stat -c%s "$FPK") bytes)"

# 4) 可选：模拟 fnOS 安装校验布局
if [ "${1:-}" = "--check" ]; then
  SIM="$(pwd)/dist-fpk/_sim_check"
  rm -rf "$SIM" 2>/dev/null || true
  mkdir -p "$SIM"
  tar -xzf "$FPK" -C "$SIM"
  mkdir -p "$SIM/app"
  tar -xzf "$SIM/app.tgz" -C "$SIM/app"
  ok=1
  for p in \
    manifest cmd/main config/privilege config/resource wizard/install.sh \
    app/backend/src/index.js app/frontend/src/App.vue app/ui/config \
    app/docker/docker-compose.yaml app/docker/Dockerfile; do
    if [ ! -e "$SIM/$p" ]; then echo "    ✗ 缺失 $p"; ok=0; fi
  done
  # 校验 cmd/main 有执行位
  for f in "$SIM/cmd/main"; do
    if [ ! -x "$f" ]; then echo "    ✗ 无执行位 $f"; ok=0; fi
  done
  if [ "$ok" = 1 ]; then echo "    ✓ 安装布局校验通过"; else rm -rf "$SIM" 2>/dev/null || true; exit 1; fi
  rm -rf "$SIM" 2>/dev/null || true
fi

echo "==> 完成: $FPK"
