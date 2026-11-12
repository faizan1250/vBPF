# vBPF Makefile — Day-1 CI skeleton.
# Every target is no-root safe except test-integration.
# Targets degrade to SKIP when their source dir is absent, so CI stays
# green before agent/, api/, web/ land. Run `make setup` first (see README).

SHELL := /bin/sh
.SHELLFLAGS := -eu -c
.PHONY: setup lint test agent-build api-dev web-dev eval test-integration recipes-check vuln secrets parity

GO ?= go
PNPM ?= pnpm

setup:
	@$(GO) version
	@node --version
	@$(PNPM) --version
	@if [ -d agent ]; then cd agent && $(GO) mod download; else echo "SKIP: no agent/ yet"; fi
	@if [ -f pnpm-workspace.yaml ]; then $(PNPM) install; else echo "SKIP: no pnpm workspace yet"; fi

lint: recipes-check
	@if [ ! -d agent ]; then echo "SKIP: no agent/ yet"; \
	else cd agent && $(GO) vet ./... && test -z "$$(gofmt -l .)" && \
	{ if command -v golangci-lint >/dev/null; then golangci-lint run ./...; else echo "SKIP: golangci-lint not installed"; fi; }; fi
	@if [ -d api ]; then $(PNPM) -C api exec tsc --noEmit; else echo "SKIP: no api/ yet"; fi
	@if [ -d web ]; then $(PNPM) -C web exec tsc --noEmit; else echo "SKIP: no web/ yet"; fi
	@if ls scripts/*.sh >/dev/null 2>&1; then shellcheck scripts/*.sh; else echo "SKIP: no scripts/ yet"; fi
	@if [ -d api ] || [ -d web ]; then $(PNPM) exec eslint . && $(PNPM) exec prettier --check .; \
		else echo "SKIP: no JS workspace yet"; fi

test:
	@if [ -d agent ]; then cd agent && $(GO) test ./...; else echo "SKIP: no agent/ yet"; fi
	@if [ -d api ]; then $(PNPM) -C api run test --run; else echo "SKIP: no api/ yet"; fi
	@if [ -d web ]; then $(PNPM) -C web run test --run; else echo "SKIP: no web/ yet"; fi

agent-build:
	@if [ -d agent ]; then cd agent && $(GO) build -o ../bin/agent ./cmd/agent; else echo "SKIP: no agent/ yet"; fi

api-dev:
	@if [ -d api ]; then $(PNPM) -C api run dev; else echo "SKIP: no api/ yet (port 8080 reserved)"; fi

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

recipes-check:
	@scripts/validate-recipes.sh

# Dependency vulnerability scan (Go). No root needed; skips when agent/ is
# absent or govulncheck is not installed. CI runs this on every push/PR.
vuln:
	@if [ -d agent ]; then cd agent && { command -v govulncheck >/dev/null || { echo "SKIP: govulncheck not installed (go install golang.org/x/vuln/cmd/govulncheck@v1.9.0)"; exit 0; }; govulncheck ./...; }; \
		else echo "SKIP: no agent/ yet"; fi

# Shared validator parity (I-04): the shape gate plus both vector suites.
# Fails when a vector exists that only one side executes.
parity:
	node scripts/parity-vectors.mjs
	@if [ -d agent ]; then cd agent && $(GO) test ./internal/server/ -run 'TestValidatorVectors' -count=1; else echo "SKIP: no agent/ yet"; fi
	@if [ -d api ]; then $(PNPM) -C api exec vitest run src/validator-vectors.test.ts; else echo "SKIP: no api/ yet"; fi

# Secret scan (R-22 keys hygiene). No root needed; skips when gitleaks is
# not installed. CI runs gitleaks-action on every push/PR instead.
secrets:
	@if command -v gitleaks >/dev/null; then gitleaks detect --source . -v; \
		else echo "SKIP: gitleaks not installed (see https://github.com/gitleaks/gitleaks#installing)"; fi
