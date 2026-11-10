# Mock-only eval harness: never needs secrets or root.
# Live eval is explicit and local-only: `make run-live` reads provider keys
# from the repo-root .env (gitignored) and never runs in CI.
PNPM ?= pnpm
.PHONY: run run-live

run:
	@if [ "$${LLM_MODE:-mock}" != "mock" ]; then echo "real-LLM eval out of scope (mock-only)"; exit 1; fi
	@$(PNPM) -C ../api run eval

run-live:
	@$(PNPM) -C ../api run eval -- --live --delay-ms 15000

run-live-real:
	@$(PNPM) -C ../api run eval -- --live --agent --delay-ms 15000
