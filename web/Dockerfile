# vBPF web: static build served by nginx, which also proxies /api and /ws to
# the API container so the browser stays same-origin. The runtime stage uses
# the unprivileged nginx variant (master and workers run as non-root uid
# 101, no root PID), so it listens on 8080 and the compose port mapping and
# healthcheck target that port.
FROM node:25-slim@sha256:81db02c4b671288a03915da9534dbd54f96d0e7c24d80ccc54f5b36b2e684370 AS builder

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

FROM nginxinc/nginx-unprivileged:1.31-alpine@sha256:b5047b9b76845eac124358373c6852377c52e4b05834a47647e955dd91cb8f1e

COPY web/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=builder /app/web/dist /usr/share/nginx/html

EXPOSE 8080

HEALTHCHECK --interval=10s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1:8080/ || exit 1
