# Mock-only eval harness: never needs secrets or root.
# Live eval is explicit and local-only: `make run-live` reads provider keys
# from the repo-root .env (gitignored) and never runs in CI.
# Eval v2 (I-10): 127 prompts with category/expected/oracle fields.
# Budgets (D-31): at most one full live run per day (--force re-runs),
# --repeat only on the 30-prompt core subset; the harness paces calls,
# stops on provider exhaustion with an `incomplete` report.
PNPM ?= pnpm
.PHONY: run run-core run-repeat run-live run-live-core run-live-real run-live-real-core run-live-real-v2 run-live-real-repeat

run:
	@if [ "$${LLM_MODE:-mock}" != "mock" ]; then echo "real-LLM eval out of scope (mock-only)"; exit 1; fi
	@$(PNPM) -C ../api run eval

run-core:
	@if [ "$${LLM_MODE:-mock}" != "mock" ]; then echo "real-LLM eval out of scope (mock-only)"; exit 1; fi
	@$(PNPM) -C ../api run eval -- --core-only

run-repeat:
	@if [ "$${LLM_MODE:-mock}" != "mock" ]; then echo "real-LLM eval out of scope (mock-only)"; exit 1; fi
	@$(PNPM) -C ../api run eval -- --core-only --repeat 3

run-live:
	@$(PNPM) -C ../api run eval --live --delay-ms 15000

run-live-core:
	@$(PNPM) -C ../api run eval --live --core-only --delay-ms 15000

run-live-real:
	@$(PNPM) -C ../api run eval --live --agent --delay-ms 15000

run-live-real-core:
	@$(PNPM) -C ../api run eval --live --agent --core-only --delay-ms 15000

run-live-real-v2:
	@$(PNPM) -C ../api run eval --live --agent --delay-ms 15000

run-live-real-repeat:
	@$(PNPM) -C ../api run eval --live --agent --core-only --repeat 3 --delay-ms 15000
