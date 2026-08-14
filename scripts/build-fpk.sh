#!/usr/bin/env bash
# ClawVault fpk 打包脚本（飞牛 fnOS 单层 gzip tarball，与 fnpack CLI 输出一致）
#
# fpk 结构（fnpack 官方规范，单层 gzip tar，无 app.tgz）：
#   manifest / cmd / wizard / config / ICON.PNG / ICON_256.PNG / app/
#   + README.md / CONTRIBUTING.md
#   - 不放外层 LICENSE（避免 fnOS 自动渲染出独立的英文「协议许可」步骤，
#     把它放进 app/backend/LICENSE 随容器交付）
#   - app/ 是顶层子目录（fnpack create --template docker 标准布局）
#   - Docker 应用：app/docker/docker-compose.yaml + app/docker/Dockerfile
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

echo "==> 打包 ClawVault v$VER fpk（单层 fpk + 顶层 app/ 子目录，对齐 fnpack 规范）"

# 1) cmd 脚本执行位（Windows 不保留 Unix 权限，强制补 755）
chmod +x cmd/main cmd/*.sh 2>/dev/null || true
echo "    ✓ cmd 脚本已确保 755"

# 2) 外层 fpk：单层 gzip tar，app/ 作为顶层子目录之一（fnpack 规范）。
#    用 tar --exclude 排除构建/运行产物（NAS 上 docker build 会自行 npm install）。
rm -f "$FPK" 2>/dev/null || true
tar -czf "$FPK" \
  --exclude='app/backend/node_modules' --exclude='*/node_modules' --exclude='*/node_modules/*' \
  --exclude='app/frontend/node_modules' \
  --exclude='app/backend/data' --exclude='app/backend/archive' \
  --exclude='app/frontend/dist' \
  manifest cmd wizard config ICON.PNG ICON_256.PNG app \
  README.md CONTRIBUTING.md
echo "    ✓ fpk: $FPK ($(stat -c%s "$FPK") bytes)"

# 4) 可选：模拟 fnOS 安装校验布局
if [ "${1:-}" = "--check" ]; then
  SIM="$(pwd)/dist-fpk/_sim_check"
  rm -rf "$SIM" 2>/dev/null || true
  mkdir -p "$SIM"
  tar -xzf "$FPK" -C "$SIM"
  ok=1
  for p in \
    manifest cmd/main config/privilege config/resource wizard/install \
    app/backend/src/index.js app/backend/LICENSE app/frontend/src/App.vue app/ui/config \
    app/docker/docker-compose.yaml app/docker/Dockerfile; do
    if [ ! -e "$SIM/$p" ]; then echo "    ✗ 缺失 $p"; ok=0; fi
  done
  # LICENSE 不应在外层根目录（避免触发 fnOS 自动英文协议步骤）
  if [ -e "$SIM/LICENSE" ]; then echo "    ✗ 外层不应有 LICENSE（会触发 fnOS 自动渲染英文协议步骤）"; ok=0; fi
  # 不应有外层 app.tgz（fnpack 规范用单层 + app/）
  if [ -e "$SIM/app.tgz" ]; then echo "    ✗ 不应有外层 app.tgz（fnpack 规范是单层 fpk + 顶层 app/）"; ok=0; fi
  # app/ 应是顶层子目录
  if [ ! -d "$SIM/app" ]; then echo "    ✗ app/ 应作为顶层子目录"; ok=0; fi
  # 校验 cmd/main 有执行位
  for f in "$SIM/cmd/main"; do
    if [ ! -x "$f" ]; then echo "    ✗ 无执行位 $f"; ok=0; fi
  done
  if [ "$ok" = "1" ]; then echo "    ✓ 安装布局校验通过"; else rm -rf "$SIM" 2>/dev/null || true; exit 1; fi
  rm -rf "$SIM" 2>/dev/null || true
fi

echo "==> 完成: $FPK"