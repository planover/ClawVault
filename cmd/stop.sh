#!/bin/sh
# FnClawVault 停止脚本（fnOS 应用生命周期：stop）
docker stop FnClawVault 2>/dev/null || true
docker rm -f FnClawVault 2>/dev/null || true
echo "FnClawVault 已停止"
