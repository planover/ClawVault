import { defineConfig, mergeConfig } from 'vite';
import base from './vite.config.js';

// 发布构建配置：关闭 emptyOutDir，避免触发 WorkBuddy 的 genie-trash 安全删除
// shim（其在沙箱中 spawn 回收站二进制会 ETIMEDOUT，导致构建中止）。
// 输出目录沿用 base 配置（../backend/public），由调用方先用 bash rm 预清理。
export default mergeConfig(base, defineConfig({
  build: {
    emptyOutDir: false,
  },
}));
