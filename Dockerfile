# PulsePass API — imagem de produção (repositório standalone).
#   docker build -t pulsepass-api .
#   docker run -p 4000:4000 --env-file .env pulsepass-api
FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production

# Manifestos primeiro (cache de camadas)
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

# Código
COPY src ./src
COPY migrations ./migrations

EXPOSE 4000
# Healthcheck bate no liveness do próprio app
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:4000/api/health || exit 1
CMD ["node", "src/server.js"]
