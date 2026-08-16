# ---- 阶段 1：构建前端（Vue 3 + Vite） ----
# 构建上下文：app/（由 app/docker/docker-compose.yaml 设置 context: ..）
# 因此 Dockerfile 内可写相对路径 backend/、frontend/、docker/Dockerfile
FROM node:18-alpine AS frontend
WORKDIR /build/frontend
COPY frontend/package.json frontend/package-lock.json* ./
RUN npm install
COPY frontend/ ./
RUN npm run build

# ---- 阶段 2：运行后端（Node + Express + SQLite） ----
FROM node:18-bookworm-slim AS backend
WORKDIR /app/backend
# better-sqlite3 需要原生编译，安装编译依赖；ffmpeg 用于语音格式转码（AMR/SILK → MP3/WAV）
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 make g++ sqlite3 libsqlite3-dev ca-certificates ffmpeg \
    && rm -rf /var/lib/apt/lists/*

COPY backend/package.json backend/package-lock.json* ./
RUN npm install --omit=dev

COPY backend/ ./
# 应用版本清单：让后端在容器内也能读取到版本号
COPY manifest /app/manifest
# 前端构建产物（vite outDir = ../backend/public，构建时相对路径已是 backend/public）
COPY --from=frontend /build/backend/public ./public

EXPOSE 6789
CMD ["node", "src/index.js"]
