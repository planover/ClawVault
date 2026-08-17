#!/usr/bin/env bash
# ClawVault 原生运行时准备（用于 fpk 打包，目标平台 linux-x64 / Node 22 ABI 127）
#
# 产物：
#   app/runtime/node/bin/node                        内置 Node 运行时
#   app/runtime/bin/ffmpeg                           可选静态 ffmpeg（AMR 语音转码，缺失则 AMR 不可播放，SILK 不受影响）
#   app/backend/node_modules/better-sqlite3/
#       build/Release/better_sqlite3.node           linux 预编译原生模块（与 Node 22 ABI 127 匹配）
#
# 设计要点：
#   - 本机构建机可能是 macOS / Linux / Windows，直接用 npm install 会拉到「本机平台」的
#     better-sqlite3 原生二进制（如 win-x64 / darwin-arm64），在 fnOS（linux-x64）上无法加载。
#     因此 better-sqlite3 用 --ignore-scripts 跳过平台预编译，这里单独注入 linux 预编译。
#   - 离线优先：若仓库根 .dl/ 下已存在对应文件（可由任意方式预先下载，如 Windows PowerShell
#     经 gh-proxy.com 拉取），则直接复用，不再联网。
#   - 联网下载时主镜像用 gh-proxy.com（实测在受限网络下可用）；ghproxy.com 已失效（返回网页）、
#     nodejs.org / cdn.npmmirror.com 在部分网络下 DNS 解析失败，故不作为首选。ffmpeg 失败不致命。
#
# 用法：
#   bash scripts/prepare-runtime.sh
set -euo pipefail

cd "$(cd "$(dirname "$0")" && pwd)/.."
REPO="$(pwd)"

NODE_VER="22.23.2"          # ABI 127，与 better-sqlite3 预编译 node-v127 对应
BSQL_VER="11.10.0"          # 必须与 app/backend/package.json 中 better-sqlite3 版本一致
FFMPEG_VER="6.1.1"          # 静态构建版本（可选）；eugeneware/ffmpeg-static 标签为 b6.1.1

RT="$REPO/app/runtime"
NODE_DIR="$RT/node"
BIN_DIR="$RT/bin"
BSQL_DIR="$REPO/app/backend/node_modules/better-sqlite3"
DL="$REPO/.dl"              # 离线预置目录（由外部下载好的二进制放这里）
mkdir -p "$RT" "$BIN_DIR" "$DL"

# 取文件：优先本地 .dl/，否则从 URL 列表依次下载（任一成功即止）
# 用法： fetch <out> <url1> [<url2> ...]
fetch() {
  local out="$1"; shift
  # 离线优先：若 .dl/ 同名或指定文件已存在则直接复用
  local base; base="$(basename "$out")"
  if [ -s "$out" ]; then echo "    ↳ 已存在，跳过: $out"; return 0; fi
  if [ -s "$DL/$base" ]; then
    cp "$DL/$base" "$out" && echo "    ↳ 复用本地预置: $DL/$base" && return 0
  fi
  local url n=0 max=4
  for url in "$@"; do
    n=0
    until curl -fsSL --connect-timeout 15 --max-time 300 "$url" -o "$out" 2>/dev/null; do
      n=$((n + 1)); [ "$n" -ge "$max" ] && { echo "    ! 镜像失败: $url" >&2; break; }; echo "    重试 ($n/$max)..."; sleep 2; done
    [ -s "$out" ] && return 0
  done
  return 1
}

# 1) Node 运行时（linux-x64）
if [ -e "$NODE_DIR/bin/node" ]; then
  echo "✓ Node 运行时已存在，跳过: $NODE_DIR/bin/node"
else
  echo "==> 准备 Node v$NODE_VER linux-x64"
  TMP="$(mktemp -d)"
  if fetch "$TMP/node.tar.gz" \
      "https://mirrors.huaweicloud.com/nodejs/v$NODE_VER/node-v$NODE_VER-linux-x64.tar.gz" \
      "https://gh-proxy.com/https://github.com/nodejs/node/releases/download/v$NODE_VER/node-v$NODE_VER-linux-x64.tar.gz" \
      "https://nodejs.org/dist/v$NODE_VER/node-v$NODE_VER-linux-x64.tar.gz" \
      "https://registry.npmmirror.com/-/binary/node/v$NODE_VER/node-v$NODE_VER-linux-x64.tar.gz"; then
    # Windows Git Bash 无法创建 symlink：排除 bin/npm|npx|corepack（运行时不需要，应用直接用 node 启动）
    # 解压到 $NODE_DIR（app/runtime/node），与 cmd/main 启动路径一致；--strip-components=1 去掉顶层 node-v*/ 前缀
    mkdir -p "$NODE_DIR"
    tar -xzf "$TMP/node.tar.gz" -C "$NODE_DIR" --strip-components=1 \
      --exclude='bin/npm' --exclude='bin/npx' --exclude='bin/corepack' 2>/dev/null || true
    chmod +x "$NODE_DIR/bin/node" 2>/dev/null || true   # 补执行位（Windows 下解压无 x，需写入 fpk 时保留）
    rm -rf "$TMP"
    # 注意：Windows 下无法运行该 Linux ELF 二进制，故用「存在 + 体积」判定，不在本机执行 node -v
    [ -e "$NODE_DIR/bin/node" ] || { echo "✗ Node 解压失败" >&2; exit 1; }
    echo "    ✓ Node 二进制已就位: $(stat -c%s "$NODE_DIR/bin/node") 字节"
  else
    rm -rf "$TMP"; echo "✗ Node 下载失败，请检查网络或手动将 node.tar.gz 放入 .dl/ 后重试" >&2; exit 1
  fi
fi

# 2) better-sqlite3 linux 预编译（Node 22 ABI 127）
if [ -f "$BSQL_DIR/build/Release/better_sqlite3.node" ]; then
  echo "✓ better-sqlite3 原生模块已存在，跳过"
else
  echo "==> 准备 better-sqlite3 v$BSQL_VER linux-x64 预编译"
  mkdir -p "$BSQL_DIR/build/Release"
  TMP="$(mktemp -d)"
  BSQL_TAR="better-sqlite3-v$BSQL_VER-node-v127-linux-x64.tar.gz"
  BSQL_URL="https://github.com/WiseLibs/better-sqlite3/releases/download/v$BSQL_VER/$BSQL_TAR"
  if fetch "$TMP/bsql.tar.gz" \
      "https://gh-proxy.com/$BSQL_URL" \
      "$BSQL_URL"; then
    tar -xzf "$TMP/bsql.tar.gz" -C "$TMP"
    NODE_BIN_FOUND="$(find "$TMP" -name 'better_sqlite3.node' | head -1)"
    if [ -n "$NODE_BIN_FOUND" ]; then
      cp "$NODE_BIN_FOUND" "$BSQL_DIR/build/Release/better_sqlite3.node"
      echo "    ✓ better_sqlite3.node ($(stat -c%s "$BSQL_DIR/build/Release/better_sqlite3.node") bytes)"
    else
      echo "    ✗ 预编译包内未找到 better_sqlite3.node" >&2; rm -rf "$TMP"; exit 1
    fi
  else
    echo "    ✗ better-sqlite3 预编译下载失败，请手动将 $BSQL_TAR 放入 .dl/ 后重试" >&2; rm -rf "$TMP"; exit 1
  fi
  rm -rf "$TMP"
fi

# 3) 可选 ffmpeg 静态二进制（AMR 语音转码用，缺失不致命）
if [ -e "$BIN_DIR/ffmpeg" ]; then
  echo "✓ ffmpeg 已存在，跳过"
else
  echo "==> 准备静态 ffmpeg (可选)"
  TMP="$(mktemp -d)"
  FFMPEG_URL="https://github.com/eugeneware/ffmpeg-static/releases/download/b$FFMPEG_VER/ffmpeg-linux-x64"
  if fetch "$TMP/ffmpeg" \
      "https://gh-proxy.com/$FFMPEG_URL" \
      "$FFMPEG_URL"; then
    mv "$TMP/ffmpeg" "$BIN_DIR/ffmpeg"
    chmod +x "$BIN_DIR/ffmpeg" 2>/dev/null || true
    echo "    ✓ ffmpeg 已就位: $(stat -c%s "$BIN_DIR/ffmpeg") 字节"
  else
    echo "    ! ffmpeg 下载失败，跳过（AMR 语音将不可播放，SILK 不受影响）"
  fi
  rm -rf "$TMP"
fi

echo "==> 运行时准备完成: $RT"
