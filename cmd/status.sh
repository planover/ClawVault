#!/bin/sh
# ClawVault 状态脚本（fnOS 应用生命周期：status）
if docker ps --format '{{.Names}}' 2>/dev/null | grep -qx ClawVault; then
  echo "running"
  exit 0
else
  echo "stopped"
  exit 3
fi
