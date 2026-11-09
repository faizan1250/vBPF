# vBPF web: static build served by nginx, which also proxies /api and /ws to
# the API container so the browser stays same-origin.
FROM node:22-slim AS builder

RUN npm install -g pnpm@9

WORKDIR /app
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY api/package.json api/package.json
COPY web/package.json web/package.json
COPY packages/schemas/package.json packages/schemas/package.json
RUN pnpm install --frozen-lockfile

COPY web web
COPY packages packages
RUN pnpm --filter @vbpf/web run build

FROM nginx:1.27-alpine

COPY web/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=builder /app/web/dist /usr/share/nginx/html

EXPOSE 80

HEALTHCHECK --interval=10s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1/ || exit 1
