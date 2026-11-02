FROM --platform=$BUILDPLATFORM golang:1.26.0-bookworm AS agent-build
WORKDIR /src/agent
COPY agent/go.mod agent/go.sum ./
RUN go mod download
COPY agent/ ./
ARG AGENT_VERSION=""
RUN set -eu; mkdir -p /out; \
    ldflags='-s -w'; \
    if [ -n "$AGENT_VERSION" ]; then ldflags="$ldflags -X trafficmon/agent/internal/monitor.Version=$AGENT_VERSION"; fi; \
    for arch in amd64 arm64; do \
      CGO_ENABLED=0 GOOS=linux GOARCH="$arch" go build -buildvcs=false -trimpath -ldflags="$ldflags" \
        -o "/out/traffic-agent-linux-$arch" ./cmd/traffic-agent; \
    done; \
    cd /out; sha256sum traffic-agent-linux-* > SHA256SUMS

FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/contracts/package.json packages/contracts/package.json
RUN npm ci --no-audit --no-fund
COPY apps apps
COPY packages packages
RUN npm run build

FROM node:24-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8766 DB_PATH=/data/control.db WEB_ROOT=/app/apps/web/dist AGENT_DIST_ROOT=/app/agent-dist
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/apps/api/dist ./apps/api/dist
COPY --from=build /app/apps/web/dist ./apps/web/dist
COPY --from=agent-build /out/ ./agent-dist/
COPY scripts/install-agent.py ./agent-dist/install-agent.py
RUN mkdir /data && chown node:node /data
USER node
EXPOSE 8766
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://127.0.0.1:8766/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "apps/api/dist/apps/api/src/main.js"]
