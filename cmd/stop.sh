#!/bin/sh
# ClawVault 停止脚本（fnOS 应用生命周期：stop）
docker stop ClawVault 2>/dev/null || true
docker rm -f ClawVault 2>/dev/null || true
echo "ClawVault 已停止"
