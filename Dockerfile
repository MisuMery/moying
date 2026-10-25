FROM node:22-slim

WORKDIR /app

# 依赖单独一层，改代码不重装。
# 带 lock：npm ci 按 lock 精确安装，构建可复现（2026-10-25 审查：原先只
# COPY package.json 走 npm install，每次构建可能装到不同的依赖版本）。
COPY package*.json ./
RUN npm ci --omit=dev --no-audit --no-fund

COPY src/ ./src/
COPY web/ ./web/
COPY templates/ ./templates/
# data/ 是运行时数据（由 deploy.sh 从 templates/ 生成后挂载进来），不进镜像。
# 建目录的同时把归属给 node 用户：容器以非 root 运行，data/ 必须可写。
RUN mkdir -p /app/data/stickers && chown -R node:node /app/data

ENV MOYING_DATA_DIR=/app/data
ENV NODE_ENV=production

# 不拿 root 跑：引擎要读 LLM 产出、要写 data/，非 root 是基本的纵深防御
# （宿主 ./data 绑定挂载的归属由 deploy.sh 负责 chown 成 1000:1000）
USER node

EXPOSE 3210

CMD ["node", "src/main.js"]
