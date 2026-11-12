# Deployment (compose hardening)

This page explains every hardening setting in `docker-compose.yml`,
`api/Dockerfile`, `web/Dockerfile`, and `web/nginx.conf` (issue I-07,
decision D-81; note: `implementation.md` labels this "D-30", but D-30 is
already taken in `docs/decisions.md`, so the TRUST_PROXY decision is
recorded here as D-81).

## Non-root services

- **API.** The image has no `USER` because the entrypoint must start as root
  to stage the root-owned `0600` agent token where `node` can read it
  (`/run/vbpf/agent.token`). It then re-execs the server via `setpriv`
  as uid 1000, so no root PID remains. Verify from a running stack:
  the server process (`node /app/api/dist/index.js`) runs as uid 1000,
  even though `exec` probes default to root.
- **Web.** The runtime stage is `nginxinc/nginx-unprivileged` (pinned by
  digest), which runs master and workers as non-root uid 101 and listens
  on 8080. No `USER` override is needed. The compose port mapping and the
  image healthcheck both target 8080.

## TRUST_PROXY (D-81)

The API rate limiter keys on `req.ip`. `TRUST_PROXY` controls whether
`X-Forwarded-For` is honored:

| Value                                   | Meaning                                                                                                   |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `false` (default)                       | Trust no proxy; key on the socket address. A client that reaches the API directly cannot spoof its IP.    |
| IP/CIDR allowlist, e.g. `172.28.0.0/16` | Trust `X-Forwarded-For` only when the immediate peer matches; otherwise fall back to the socket address.  |
| `true`                                  | Trust everyone. Tests only; never in front of untrusted clients.                                          |
| bare number (hop count)                 | Fails closed to `false`. Fastify cannot validate the immediate peer from a count, so counts are rejected. |

Compose sets `TRUST_PROXY=172.28.0.0/16`, the fixed subnet of the `vbpf`
bridge network declared at the bottom of `docker-compose.yml`. Only the
web front door publishes a host port, so every API peer on that network
is a compose container and the nginx hop carries the real client IP.
Native `pnpm -C api run dev` keeps the default: loopback socket address.

## nginx limits

- `server_tokens off` hides the version banner.
- `client_max_body_size 64k` on the API locations matches the API's own
  64 KB body cap; oversize input is rejected at the edge.
- `proxy_connect_timeout 5s` fails fast on a dead upstream;
  `proxy_send_timeout 30s` bounds slow-client writes;
  `proxy_read_timeout 120s` stays above the 90 s LLM budget and the 60 s
  max run stream so slow generations are not cut off with a 504.
- `limit_req_zone $binary_remote_addr zone=llm:10m rate=10r/m` plus
  `limit_req` on the exact `/api/generate` and `/api/explain` locations
  is a second layer in front of the API's own shared 10 req/min/IP
  bucket (both endpoints draw from one bucket on both layers).
  Over-limit replies are `429` on both layers.
- `Permissions-Policy: camera=(), microphone=(), geolocation=()` locks
  down powerful features the UI never uses.
- HSTS is intentionally absent: this front door serves plain HTTP on
  loopback. Terminate TLS in front of it and set HSTS there.

## Container constraints (all services)

- `cap_drop: [ALL]` drops every Linux capability; neither service needs
  any (no low-port bind, no raw sockets).
- `security_opt: [no-new-privileges:true]` blocks setuid escalation.
- `read_only: true` with `tmpfs` mounts (`/tmp` and `/run/vbpf` for the
  API; `/tmp`, `/var/cache/nginx`, `/var/run` for web). The API's
  SQLite file lives on the `api-data` named volume at `/data`, owned by
  `node`.
- `mem_limit` (api 512m, web 128m) and `pids_limit` (api 100, web 50)
  bound a runaway worker. `restart: unless-stopped` keeps the stack up
  across daemon restarts.

## Container constraints (agent)

- The agent runs with the minimal tracing capability set instead of full
  root (I-08, D-84): `cap_add: [BPF, PERFMON, SYS_RESOURCE]` plus
  `cap_drop: [ALL]` and `security_opt: [no-new-privileges:true]`. No
  `privileged`, no `pid: host` (probes are kernel-wide; the container's
  own PID namespace is enough for the startup `pgrep` sweep, which only
  ever matches the agent's own `vbpf-*.bt` children).
- Tracefs/debugfs are mounted `:ro`. On kernels where bpftrace needs a
  tracefs write, use the documented fallback override instead of
  widening the default:
  `docker compose -f docker-compose.yml -f docker-compose.privileged.yml up --build -d`
  (re-grants `privileged`, `pid: host`, `:rw` mounts).
- At startup the agent additionally sets `no_new_privs` and masks its own
  sets to the retain set via `capset`, logging the final set
  (`agent/internal/priv`; best-effort, warned-and-continued when
  unprivileged).
- `scripts/check-privilege.sh` (manual, Docker + BPF-capable kernel)
  verifies the limited stack: health, validate + dry-run, run, stop,
  exact PID 1 caps, and failing `mknod`/`mount`/tracefs-write negatives.

## Smoke checks

```sh
docker compose config --quiet            # compose validates
docker compose up --build -d             # health passes as non-root
docker compose exec api sh -c 'stat -c %U /proc/1'  # server user (node)
docker compose exec web sh -c 'id -u'    # non-zero (101)
curl -sI http://localhost:5173/ | grep -iE 'x-content-type-options|x-frame-options|referrer-policy|content-security-policy|permissions-policy'
scripts/check-headers.sh                 # same assertions, non-zero on miss
```

`TRUST_PROXY` behavior is covered by unit tests
(`api/src/generate.test.ts`: spoofed header honored from the proxy peer,
ignored from an untrusted peer) and the nginx shape by
`web/src/nginx.conf.test.ts`; CI runs `nginx -t` against the pinned
image in the `docker-build` job.
