FROM node:22-alpine

ENV NODE_ENV=production
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY index.js ./
COPY src ./src
COPY scripts ./scripts

USER node
EXPOSE 8080
CMD ["node", "index.js"]
