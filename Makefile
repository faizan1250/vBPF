# vBPF Makefile — Day-1 CI skeleton.
# Every target is no-root safe except test-integration.
# Targets degrade to SKIP when their source dir is absent, so CI stays
# green before agent/, api/, web/ land. Run `make setup` first (see README).

SHELL := /bin/sh
.SHELLFLAGS := -eu -c
.PHONY: setup lint test agent-build api-dev web-dev eval test-integration

GO ?= go
PNPM ?= pnpm

setup:
	@$(GO) version
	@node --version
	@$(PNPM) --version
	@if [ -d agent ]; then cd agent && $(GO) mod download; else echo "SKIP: no agent/ yet"; fi
	@if [ -f pnpm-workspace.yaml ]; then $(PNPM) install; else echo "SKIP: no pnpm workspace yet"; fi

lint:
	@if [ ! -d agent ]; then echo "SKIP: no agent/ yet"; \
	else cd agent && $(GO) vet ./... && test -z "$$(gofmt -l .)" && \
	{ command -v golangci-lint >/dev/null && golangci-lint run ./... || echo "SKIP: golangci-lint not installed"; }; fi
	@if [ -d api ]; then $(PNPM) -C api exec tsc --noEmit; else echo "SKIP: no api/ yet"; fi
	@if [ -d web ]; then $(PNPM) -C web exec tsc --noEmit; else echo "SKIP: no web/ yet"; fi
	@if ls scripts/*.sh >/dev/null 2>&1; then shellcheck scripts/*.sh; else echo "SKIP: no scripts/ yet"; fi
	@if [ -d api ] || [ -d web ]; then $(PNPM) exec eslint . && $(PNPM) exec prettier --check .; \
		else echo "SKIP: no JS workspace yet"; fi

test:
	@if [ -d agent ]; then cd agent && $(GO) test ./...; else echo "SKIP: no agent/ yet"; fi
	@if [ -d api ]; then $(PNPM) -C api run test -- --run; else echo "SKIP: no api/ yet"; fi
	@if [ -d web ]; then $(PNPM) -C web run test -- --run; else echo "SKIP: no web/ yet"; fi

agent-build:
	@if [ -d agent ]; then cd agent && $(GO) build -o ../bin/agent ./...; else echo "SKIP: no agent/ yet"; fi

api-dev:
	@if [ -d api ]; then $(PNPM) -C api run dev --port 8080; else echo "SKIP: no api/ yet (port 8080 reserved)"; fi

web-dev:
	@if [ -d web ]; then $(PNPM) -C web run dev --port 5173; else echo "SKIP: no web/ yet (port 5173 reserved)"; fi

# Mock-only eval: never needs secrets or root. Real LLM runs are out of scope for CI.
eval:
	@if [ -d eval ]; then LLM_MODE=mock $(MAKE) --no-print-directory -C eval run; \
		else echo "SKIP: no eval/ yet (mock mode, LLM_UNAVAILABLE fallback)"; fi

# Root + bpftrace + BTF required. Expected SKIP/FAIL on stock hosted runners;
# run via .github/workflows/integration-manual.yml (workflow_dispatch) instead.
# Go integration tests must carry the build tag: //go:build integration
test-integration:
	@if [ "$$(id -u)" -ne 0 ]; then echo "SKIP: test-integration needs root (expected on hosted runners)"; exit 0; fi
	@command -v bpftrace >/dev/null || (echo "SKIP: bpftrace not installed"; exit 0)
	@if [ -d agent ]; then cd agent && $(GO) test -tags integration ./...; \
		else echo "SKIP: no agent/ yet"; fi
