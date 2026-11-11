# vBPF API: TypeScript is compiled to dist/ in the build stage. The runtime
# stage installs production dependencies only and runs the server as the
# non-root node user: the entrypoint stages the root-owned 0600 agent token
# where node can read it, then re-execs the server as uid 1000 via setpriv.
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

# Compile workspace TS (api + @vbpf/schemas) to plain JS, then point the
# staged schemas manifest at dist/ so plain node resolves compiled output.
RUN pnpm --filter @vbpf/schemas run build \
  && node --input-type=module -e "import{readFileSync,writeFileSync}from'node:fs';const p='packages/schemas/package.json';const j=JSON.parse(readFileSync(p));j.main='./dist/index.js';j.types='./dist/index.d.ts';writeFileSync(p,JSON.stringify(j,null,2)+'\n')" \
  && pnpm --filter @vbpf/api run build

FROM node:22-slim AS runtime

RUN npm install -g pnpm@9

WORKDIR /app
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY api/package.json api/package.json
COPY web/package.json web/package.json
COPY packages/schemas/package.json packages/schemas/package.json
RUN pnpm install --frozen-lockfile --prod

COPY --from=builder /app/packages/schemas/dist ./packages/schemas/dist
COPY --from=builder /app/packages/schemas/package.json ./packages/schemas/package.json
COPY --from=builder /app/api/dist ./api/dist
COPY api/prompts ./api/prompts
COPY api/entrypoint.sh ./api/entrypoint.sh
COPY recipes ./recipes
RUN mkdir -p /data /run/vbpf && chown node:node /data /run/vbpf && chmod 0755 /app/api/entrypoint.sh

ENV HOST=0.0.0.0 \
  PORT=8080 \
  AGENT_URL=http://agent:8787 \
  AGENT_TOKEN_FILE=/token/agent.token \
  DATABASE_PATH=/data/api.sqlite3 \
  RECIPES_DIR=/app/recipes

EXPOSE 8080

HEALTHCHECK --interval=10s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8080/api/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

ENTRYPOINT ["/app/api/entrypoint.sh"]
CMD ["/usr/local/bin/node", "/app/api/dist/index.js"]
