# Bubble Bridge — MCP remoto (Streamable HTTP) para a rede interna.
FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
RUN npm ci
COPY src ./src
RUN npm run build

FROM node:22-slim AS runtime
ENV NODE_ENV=production \
    BUBBLE_BRIDGE_HTTP_HOST=0.0.0.0 \
    BUBBLE_BRIDGE_HTTP_PORT=8787 \
    BUBBLE_BRIDGE_CLIENTS_FILE=/data/clients.json \
    BUBBLE_AUDIT_LOG=/data/logs/audit.jsonl \
    BUBBLE_EXPORT_DIR=/data/exports
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
# Volume nomeado herda o dono deste diretório: o processo roda sem root.
RUN mkdir -p /data/logs /data/exports && chown -R node:node /data
USER node
VOLUME ["/data"]
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.BUBBLE_BRIDGE_HTTP_PORT||8787)+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["node", "dist/cli.js", "serve", "--http"]
