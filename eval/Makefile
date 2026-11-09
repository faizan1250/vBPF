# Mock-only eval harness: never needs secrets or root.
PNPM ?= pnpm
.PHONY: run

run:
	@if [ "$${LLM_MODE:-mock}" != "mock" ]; then echo "real-LLM eval out of scope (mock-only)"; exit 1; fi
	@$(PNPM) -C ../api run eval
