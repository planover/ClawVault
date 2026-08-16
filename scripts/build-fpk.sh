#!/usr/bin/env bash
# ClawVault fpk 打包脚本（飞牛 fnOS 双层 gzip tarball，对齐 fnpack 官方规范）
#
# fpk 结构（fnpack 规范，参考 FNOSP/App.Docker.Linker 官方打包示例）：
#   外层 fpk 顶层（fnOS 安装器第一步就解这个）：
#     manifest / cmd / wizard / config / ICON.PNG / ICON_256.PNG / app.tgz
#     + README.md / CONTRIBUTING.md（可选）
#   内层 app.tgz 内容（fnOS 第二步解到 ${TRIM_APPDEST}/app/）：
#     backend / frontend / ui / docker
#     没有 app/ 前缀（用 -C app + 相对路径），解包后直接落在 app/ 下
#   cmd/main 启动 docker 时用 ${TRIM_APPDEST}/app/docker/docker-compose.yaml
#
# 为什么不放外层 LICENSE：避免 fnOS 自动渲染独立的英文「协议许可」步骤；
# 中英双语协议放在 wizard/install（v1.0.5 改）。
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

echo "==> 打包 ClawVault v$VER fpk（双层 fpk：外层含 app.tgz，内层含 backend/frontend/ui/docker）"

# 1) cmd 脚本执行位（Windows 不保留 Unix 权限，强制补 755）
chmod +x cmd/main cmd/*.sh 2>/dev/null || true
echo "    ✓ cmd 脚本已确保 755"

# 2) 内层 app.tgz：在 app/ 下打，路径以 backend/frontend/ui/docker 开头（不带 app/ 前缀），
#    fnOS 解开后会落在 ${TRIM_APPDEST}/app/{backend,frontend,ui,docker}/
[ -d app ] || { echo "✗ 缺少 app/ 目录" >&2; exit 1; }
rm -f app.tgz 2>/dev/null || true
( cd app && tar -czf ../app.tgz \
    --exclude='node_modules' --exclude='*/node_modules' --exclude='*/node_modules/*' \
    --exclude='public' --exclude='dist' --exclude='data' --exclude='archive' \
    backend frontend ui docker )
echo "    ✓ app.tgz ($(stat -c%s app.tgz) bytes)"

# 3) 外层 fpk：app.tgz 作为顶层文件之一（fnpack 规范）
rm -f "$FPK" 2>/dev/null || true
tar -czf "$FPK" \
  manifest cmd wizard config ICON.PNG ICON_256.PNG app.tgz \
  README.md CONTRIBUTING.md
echo "    ✓ fpk: $FPK ($(stat -c%s "$FPK") bytes)"

# 4) 可选：模拟 fnOS 安装校验布局
if [ "${1:-}" = "--check" ]; then
  SIM="$(pwd)/dist-fpk/_sim_check"
  rm -rf "$SIM" 2>/dev/null || true
  mkdir -p "$SIM"
  # 模拟 fnOS 第一步：解外层 fpk 到 ${TRIM_APPDEST}
  tar -xzf "$FPK" -C "$SIM"
  # 模拟 fnOS 第二步：解 app.tgz 直接铺平到 ${TRIM_APPDEST}（注意：无 app/ 中间层！）
  # v1.0.9 实测 fnOS 把 app.tgz 内容直接铺平到应用根，cmd/main 用的是 ${TRIM_APPDEST}/docker/...
  mkdir -p "$SIM"
  tar -xzf "$SIM/app.tgz" -C "$SIM"
  ok=1
  # 注意这里的路径都是"铺平后"的（无 app/ 前缀）
  for p in \
    manifest cmd/main config/privilege config/resource wizard/install \
    backend/src/index.js backend/src/routes/health.js frontend/src/App.vue ui/config \
    docker/docker-compose.yaml docker/Dockerfile; do
    if [ ! -e "$SIM/$p" ]; then echo "    ✗ 缺失 $p"; ok=0; fi
  done
  # LICENSE 不应在外层根目录（避免触发 fnOS 自动英文协议步骤）
  if [ -e "$SIM/LICENSE" ]; then echo "    ✗ 外层不应有 LICENSE（会触发 fnOS 自动渲染英文协议步骤）"; ok=0; fi
  # app.tgz 必须是外层 fpk 的顶层文件（fnpack 规范）
  if [ ! -f "$SIM/app.tgz" ]; then echo "    ✗ 外层 fpk 应含 app.tgz（fnpack 规范）"; ok=0; fi
  # 校验 cmd/main 有执行位
  for f in "$SIM/cmd/main"; do
    if [ ! -x "$f" ]; then echo "    ✗ 无执行位 $f"; ok=0; fi
  done
  if [ "$ok" = "1" ]; then echo "    ✓ 安装布局校验通过（铺平布局）"; else rm -rf "$SIM" 2>/dev/null || true; exit 1; fi
  rm -rf "$SIM" 2>/dev/null || true
fi

echo "==> 完成: $FPK"
