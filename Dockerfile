FROM node:22-alpine

ENV NODE_ENV=production
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# 動いているバージョンを表示するためのコミット ID（GitHub Actions から渡す）
ARG APP_VERSION=""
ENV APP_VERSION=$APP_VERSION

COPY index.js ./
COPY src ./src
COPY scripts ./scripts

USER node
EXPOSE 8080
CMD ["node", "index.js"]
