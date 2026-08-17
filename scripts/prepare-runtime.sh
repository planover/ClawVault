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
#   - 联网下载时主镜像用 cdn.npmmirror.com / mirrors.huaweicloud.com（国内实测可用）；
#     gh-proxy.com 仅作为 GitHub 直链的 fallback（某些网络下会返回网页或 0 字节）。
#   - 最终二进制（node / better_sqlite3.node / ffmpeg）下载后强制校验为 Linux ELF（\x7fELF），
#     避免把 HTML 错误页或 Windows PE 打包进 fpk。
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

# 判断文件是否为 Linux ELF（PE 是 MZ，HTML 是 <ht...）
is_elf() {
  local f="$1"
  [ -s "$f" ] || return 1
  # 读取前 4 字节并与 0x7f454c46 比较
  local head
  head="$(head -c 4 "$f" 2>/dev/null | od -An -tx1 | tr -d ' \n')" || true
  [ "$head" = "7f454c46" ]
}

# 判断文件是否为 gzip（tar.gz 中间包）
is_gzip() {
  local f="$1"
  [ -s "$f" ] || return 1
  local head
  head="$(head -c 2 "$f" 2>/dev/null | od -An -tx1 | tr -d ' \n')" || true
  [ "$head" = "1f8b" ]
}

# 取文件：优先本地 .dl/，否则从 URL 列表依次下载。
# 用法： fetch [--elf] <out> <url1> [<url2> ...]
#   --elf  下载后校验文件头为 Linux ELF（用于最终可执行文件）
fetch() {
  local check_elf=false
  if [ "${1:-}" = "--elf" ]; then check_elf=true; shift; fi
  local out="$1"; shift
  local base; base="$(basename "$out")"

  # 如果目标已存在且校验通过，直接复用
  if { [ "$check_elf" = false ] && [ -s "$out" ]; } || { [ "$check_elf" = true ] && is_elf "$out"; }; then
    echo "    ↳ 已存在且校验通过: $out"
    return 0
  fi

  # 离线优先：若 .dl/ 下同名文件存在则复用（最终二进制要求 ELF）
  if [ -s "$DL/$base" ]; then
    if [ "$check_elf" = true ] && ! is_elf "$DL/$base"; then
      echo "    ! 本地预置 $DL/$base 不是 ELF，忽略" >&2
    else
      cp "$DL/$base" "$out" && echo "    ↳ 复用本地预置: $DL/$base" && return 0
    fi
  fi

  local url n=0 max=3
  for url in "$@"; do
    n=0
    until curl -fsSL --connect-timeout 15 --max-time 300 "$url" -o "$out" 2>/dev/null; do
      n=$((n + 1))
      [ "$n" -ge "$max" ] && { echo "    ! 下载失败: $url" >&2; break; }
      echo "    重试 ($n/$max): $url"
      sleep 2
    done

    # 下载成功后的校验
    if [ "$check_elf" = true ]; then
      if is_elf "$out"; then
        cp "$out" "$DL/$base" 2>/dev/null || true
        return 0
      fi
      echo "    ! 下载内容不是 Linux ELF: $url" >&2
      rm -f "$out"
    else
      # 中间包只需非空（tar.gz 会额外用 is_gzip 校验）
      if [ -s "$out" ]; then
        cp "$out" "$DL/$base" 2>/dev/null || true
        return 0
      fi
      echo "    ! 下载内容为空: $url" >&2
      rm -f "$out"
    fi
  done
  return 1
}

# 1) Node 运行时（linux-x64）
if is_elf "$NODE_DIR/bin/node"; then
  echo "✓ Node 运行时已存在且校验通过: $NODE_DIR/bin/node"
else
  echo "==> 准备 Node v$NODE_VER linux-x64"
  TMP="$(mktemp -d)"
  if fetch "$TMP/node.tar.gz" \
      "https://cdn.npmmirror.com/binaries/node/v$NODE_VER/node-v$NODE_VER-linux-x64.tar.gz" \
      "https://mirrors.huaweicloud.com/nodejs/v$NODE_VER/node-v$NODE_VER-linux-x64.tar.gz" \
      "https://gh-proxy.com/https://github.com/nodejs/node/releases/download/v$NODE_VER/node-v$NODE_VER-linux-x64.tar.gz" \
      "https://nodejs.org/dist/v$NODE_VER/node-v$NODE_VER-linux-x64.tar.gz"; then
    # Windows Git Bash 无法创建 symlink：排除 bin/npm|npx|corepack（运行时不需要，应用直接用 node 启动）
    # 解压到 $NODE_DIR（app/runtime/node），与 cmd/main 启动路径一致；--strip-components=1 去掉顶层 node-v*/ 前缀
    rm -rf "$NODE_DIR"
    mkdir -p "$NODE_DIR"
    tar -xzf "$TMP/node.tar.gz" -C "$NODE_DIR" --strip-components=1 \
      --exclude='bin/npm' --exclude='bin/npx' --exclude='bin/corepack' 2>/dev/null || true
    chmod +x "$NODE_DIR/bin/node" 2>/dev/null || true
    rm -rf "$TMP"
    is_elf "$NODE_DIR/bin/node" || { echo "✗ Node 二进制不是 Linux ELF" >&2; exit 1; }
    echo "    ✓ Node 二进制已就位: $(stat -c%s "$NODE_DIR/bin/node") 字节"
  else
    rm -rf "$TMP"
    echo "✗ Node 下载失败，请检查网络或手动将 node.tar.gz 放入 .dl/ 后重试" >&2
    exit 1
  fi
fi

# 2) better-sqlite3 linux 预编译（Node 22 ABI 127）
# 注意：本机 npm install 可能残留 Windows PE 或 darwin Mach-O，必须强制替换为 Linux ELF。
BSQL_NODE="$BSQL_DIR/build/Release/better_sqlite3.node"
if is_elf "$BSQL_NODE"; then
  echo "✓ better-sqlite3 原生模块已存在且为 Linux ELF"
else
  echo "==> 准备 better-sqlite3 v$BSQL_VER linux-x64 预编译"
  # 用 mv 移出仓库（而非 rm），避免 Windows safe-delete 守护拦截删除导致脚本中断
  [ -e "$BSQL_NODE" ] && mv -f "$BSQL_NODE" /tmp/bsql-stale-$$.node 2>/dev/null || true
  mkdir -p "$BSQL_DIR/build/Release"
  TMP="$(mktemp -d)"
  BSQL_TAR="better-sqlite3-v$BSQL_VER-node-v127-linux-x64.tar.gz"
  BSQL_URL="https://github.com/WiseLibs/better-sqlite3/releases/download/v$BSQL_VER/$BSQL_TAR"
  if fetch "$TMP/bsql.tar.gz" \
      "https://cdn.npmmirror.com/binaries/better-sqlite3/v$BSQL_VER/$BSQL_TAR" \
      "https://gh-proxy.com/$BSQL_URL" \
      "$BSQL_URL"; then
    # 中间 tar.gz 额外校验 gzip 头，避免拿到 HTML
    if ! is_gzip "$TMP/bsql.tar.gz"; then
      echo "✗ better-sqlite3 下载包不是 gzip（可能是 HTML 错误页）" >&2
      rm -rf "$TMP"
      exit 1
    fi
    tar -xzf "$TMP/bsql.tar.gz" -C "$TMP"
    NODE_BIN_FOUND="$(find "$TMP" -name 'better_sqlite3.node' | head -1)"
    if [ -n "$NODE_BIN_FOUND" ]; then
      cp "$NODE_BIN_FOUND" "$BSQL_NODE"
      rm -rf "$TMP"
      is_elf "$BSQL_NODE" || { echo "✗ better_sqlite3.node 不是 Linux ELF" >&2; exit 1; }
      echo "    ✓ better_sqlite3.node ($(stat -c%s "$BSQL_NODE") bytes)"
    else
      echo "    ✗ 预编译包内未找到 better_sqlite3.node" >&2
      rm -rf "$TMP"
      exit 1
    fi
  else
    echo "    ✗ better-sqlite3 预编译下载失败，请手动将 $BSQL_TAR 放入 .dl/ 后重试" >&2
    rm -rf "$TMP"
    exit 1
  fi
fi

# 3) 可选 ffmpeg 静态二进制（AMR 语音转码用，缺失不致命）
if is_elf "$BIN_DIR/ffmpeg"; then
  echo "✓ ffmpeg 已存在且校验通过"
else
  echo "==> 准备静态 ffmpeg (可选)"
  rm -f "$BIN_DIR/ffmpeg"
  TMP="$(mktemp -d)"
  FFMPEG_URL="https://github.com/eugeneware/ffmpeg-static/releases/download/b$FFMPEG_VER/ffmpeg-linux-x64"
  # ffmpeg 是最终 ELF 二进制，使用 --elf 校验
  if fetch --elf "$TMP/ffmpeg" \
      "https://cdn.npmmirror.com/binaries/ffmpeg-static/b$FFMPEG_VER/ffmpeg-linux-x64" \
      "https://gh-proxy.com/$FFMPEG_URL" \
      "$FFMPEG_URL"; then
    mv "$TMP/ffmpeg" "$BIN_DIR/ffmpeg"
    chmod +x "$BIN_DIR/ffmpeg" 2>/dev/null || true
    is_elf "$BIN_DIR/ffmpeg" || { echo "✗ ffmpeg 不是 Linux ELF" >&2; rm -f "$BIN_DIR/ffmpeg"; exit 1; }
    echo "    ✓ ffmpeg 已就位: $(stat -c%s "$BIN_DIR/ffmpeg") 字节"
  else
    echo "    ! ffmpeg 下载失败，跳过（AMR 语音将不可播放，SILK 不受影响）"
  fi
  rm -rf "$TMP"
fi

echo "==> 运行时准备完成: $RT"
