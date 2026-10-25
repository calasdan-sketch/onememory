# Build stage: compile TypeScript -> dist/
FROM node:24-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci --ignore-scripts
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# Runtime stage: prod deps only, no toolchain
FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
RUN npm ci --omit=dev --ignore-scripts
COPY --from=build /app/dist ./dist
COPY SKILL.md INSTALL.md INFRA.md SECURITY.md README.md LICENSE ./

# Notes live on a mounted volume so they survive container restarts.
ENV ONEMEMORY_HOME=/data
ENV ONEMEMORY_DB_PATH=/data/state.db
# The node:alpine image ships an unprivileged `node` user; give it the data dir
# and run as it rather than root (defence in depth).
RUN mkdir -p /data && chown -R node:node /data
VOLUME ["/data"]
USER node

# 8790 = HTTP API + dashboard, 8791 = MCP over HTTP (for the tunnel).
EXPOSE 8790 8791

# Readiness probe hits /ready (which actually touches the DB), not just /health.
HEALTHCHECK --interval=30s --timeout=3s --start-period=60s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8790/ready || exit 1

CMD ["node", "dist/src/cli.js", "start"]
