# ---- 阶段 1：构建前端（Vue 3 + Vite） ----
FROM node:18-alpine AS frontend
WORKDIR /build/frontend
COPY app/frontend/package.json app/frontend/package-lock.json* ./
RUN npm install
COPY app/frontend/ ./
RUN npm run build

# ---- 阶段 2：运行后端（Node + Express + SQLite） ----
FROM node:18-bookworm-slim AS backend
WORKDIR /app/backend
# better-sqlite3 需要原生编译，安装编译依赖
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 make g++ sqlite3 libsqlite3-dev ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY app/backend/package.json app/backend/package-lock.json* ./
RUN npm install --omit=dev

COPY app/backend/ ./
# 前端构建产物（vite outDir 指向 backend/public）
COPY --from=frontend /build/backend/public ./public

EXPOSE 6789
CMD ["node", "src/index.js"]
