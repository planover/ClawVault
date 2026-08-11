import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

// 构建产物输出到后端 public 目录，由 Express 托管
export default defineConfig({
  plugins: [vue()],
  base: './',
  build: {
    outDir: '../backend/public',
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:6789',
      '/ws': { target: 'ws://localhost:6789', ws: true },
    },
  },
});
