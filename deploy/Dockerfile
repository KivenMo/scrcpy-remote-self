# 远程协助中继 —— 最小镜像
FROM node:22-alpine
WORKDIR /app
COPY server/ ./server/
COPY controller/ ./controller/
EXPOSE 8080 8081
ENV NODE_ENV=production
CMD ["node", "server/server.js"]
