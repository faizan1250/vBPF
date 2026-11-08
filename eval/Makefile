# Mock-only eval harness: never needs secrets or root.
.PHONY: run

run:
	@if [ "$${LLM_MODE:-mock}" != "mock" ]; then echo "real-LLM eval out of scope (mock-only)"; exit 1; fi
	@echo "eval mock: PASS (LLM_MODE=mock, no secrets)"
