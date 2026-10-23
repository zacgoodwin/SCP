# Base image pinned by digest (multi-arch index) so a re-pushed tag cannot change the build; Dependabot bumps it.
FROM node:24.22.1-bookworm-slim@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205 AS web
WORKDIR /app/web
COPY web/package.json web/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY web/ ./
RUN npm run build

FROM node:24.22.1-bookworm-slim@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205
ENV NODE_ENV=production \
    PORT=8080 \
    SCP_ARTIFACT_PORT=8081 \
    SCP_DB_PATH=/data/scp.db \
    SCP_WEB_DIST=/app/web/dist
WORKDIR /app
COPY server/package.json server/package-lock.json ./server/
RUN cd server && npm ci --omit=dev --no-audit --no-fund
COPY server/src ./server/src
COPY --from=web /app/web/dist ./web/dist
RUN mkdir -p /data && chown node:node /data
VOLUME /data
EXPOSE 8080 8081
USER node
HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8080/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server/src/main.ts"]
