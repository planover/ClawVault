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
# npm ci：严格按 lockfile 安装，保证可复现构建（SEC-13）
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund \
    || npm install --omit=dev --no-audit --no-fund

COPY app/backend/ ./
# 前端构建产物（vite outDir 指向 backend/public）
COPY --from=frontend /build/backend/public ./public

# SEC-13：以非 root 运行。容器被拿下时攻击者只是 uid 1000 的普通人，
# 不能改代码、不能装包、不能绑定低端口。数据/归档卷需在挂载后属 node 用户可写
# （named volume 首次挂载会自动按镜像内属主初始化；绑定挂载请自行 chown 1000:1000）。
RUN chown -R node:node /app
USER node

EXPOSE 6789
CMD ["node", "src/index.js"]
