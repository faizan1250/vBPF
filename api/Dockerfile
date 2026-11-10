# vBPF API: runs the TypeScript source via tsx (same entrypoint as native
# `make api-dev`), so the workspace @vbpf/schemas import needs no build step.
FROM node:22-slim AS builder

RUN npm install -g pnpm@9 \
  && for i in 1 2 3 4 5; do \
    if apt-get update; then break; fi; \
    if [ "$i" -eq 5 ]; then exit 1; fi; \
    echo "apt-get update failed (attempt $i/5), retrying in 10s..."; \
    sleep 10; \
  done \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY api/package.json api/package.json
COPY web/package.json web/package.json
COPY packages/schemas/package.json packages/schemas/package.json
RUN pnpm install --frozen-lockfile

COPY api api
COPY packages packages
COPY recipes recipes

FROM node:22-slim

WORKDIR /app
# devDeps retained: runtime executes TS via tsx with no build step.
COPY --from=builder /app /app

ENV HOST=0.0.0.0 \
  PORT=8080 \
  AGENT_URL=http://agent:8787 \
  AGENT_TOKEN_FILE=/token/agent.token \
  DATABASE_PATH=/data/api.sqlite3 \
  RECIPES_DIR=/app/recipes

EXPOSE 8080

HEALTHCHECK --interval=10s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8080/api/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

CMD ["/app/api/node_modules/.bin/tsx", "/app/api/src/index.ts"]
