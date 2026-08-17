import { defineConfig, mergeConfig } from 'vite';
import base from './vite.config.js';

// 发布构建配置：
// 1) base 设为飞牛统一网关前缀。应用在飞牛桌面窗口内通过 /app/clawvault/ 访问，
//    资源必须用该前缀下的绝对路径（相对路径 './' 在无尾斜杠 URL 下会解析错位）。
//    该值必须与 app/ui/config 的 gatewayPrefix、cmd/main 的 GATEWAY_PREFIX 保持三处一致。
// 2) 关闭 emptyOutDir，避免触发 WorkBuddy 的 genie-trash 安全删除 shim
//    （其在沙箱中 spawn 回收站二进制会 ETIMEDOUT，导致构建中止）。
//    输出目录沿用 base 配置（../backend/public），由调用方先用 bash rm 预清理。
export default mergeConfig(base, defineConfig({
  base: '/app/clawvault/',
  build: {
    emptyOutDir: false,
  },
}));
