# Environment (stub)

Local runs read `.env` (gitignored); copy it from `.env.example`. Never commit
real provider keys, and never add them to CI secrets — CI always runs with
`LLM_MODE=mock`.

- Tools: Go 1.22+, Node 22 LTS, pnpm 9.x.
- Reserved loopback ports: web 5173, api 8080, agent 8787.
- Safety caps for generated probes: see `MAX_DURATION_S`, `BPFTRACE_*` in
  `.env.example`.
