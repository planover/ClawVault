#!/bin/sh
# FnClawVault 启动脚本（fnOS 应用生命周期：start）
set -e

APP="FnClawVault"
IMAGE="fnclawvault:1.0.0"
PORT="${PORT:-6789}"
ARCHIVE="${ARCHIVE_ROOT:-/vol1/@app/FnClawVault}"
DATA="${DATA_DIR:-/vol1/@app/FnClawVault/data}"

mkdir -p "$ARCHIVE" "$DATA"

# 若本地无镜像则尝试从仓库拉取（社区发布时替换为你的镜像地址）
if ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
  echo "本地未找到镜像 $IMAGE，尝试拉取..."
  docker pull "$IMAGE" || echo "拉取失败，请先构建镜像（见 README）。"
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

echo "FnClawVault 已启动，访问 http://<飞牛IP>:${PORT}"
