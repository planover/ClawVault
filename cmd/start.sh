#!/bin/sh
# ClawVault 启动脚本（fnOS 应用生命周期：start）
set -e

APP="ClawVault"
IMAGE="clawvault:1.0.0"
PORT="${PORT:-6789}"
ARCHIVE="${ARCHIVE_ROOT:-/vol1/@app/ClawVault}"
DATA="${DATA_DIR:-/vol1/@app/ClawVault/data}"
# 应用根目录（fpk 解压后的目录，含 Dockerfile）
APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"

mkdir -p "$ARCHIVE" "$DATA"

# 镜像缺失时：优先从仓库拉取，失败则本地构建（fpk 已自带 Dockerfile 与源码，自包含）
if ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
  echo "本地未找到镜像 $IMAGE，尝试拉取..."
  if ! docker pull "$IMAGE" 2>/dev/null; then
    echo "拉取失败，改用本地构建（首次较慢，需联网拉取基础镜像与 npm 依赖）..."
    docker build -t "$IMAGE" "$APP_DIR"
  fi
fi

docker rm -f "$APP" 2>/dev/null || true
docker run -d \
  --name "$APP" \
  --restart unless-stopped \
  -p "${PORT}:6789" \
  -e PORT=6789 \
  -e ARCHIVE_ROOT=/archive \
  -e DATA_DIR=/data \
  -e AI_API_KEY="${AI_API_KEY:-}" \
  -e AI_BASE_URL="${AI_BASE_URL:-https://api.anthropic.com}" \
  -e AI_MODEL="${AI_MODEL:-claude-sonnet-4-5}" \
  -e DEMO_MODE="${DEMO_MODE:-false}" \
  -v "${DATA}:/data" \
  -v "${ARCHIVE}:/archive" \
  "$IMAGE"

echo "ClawVault 已启动，访问 http://<飞牛IP>:${PORT}"
