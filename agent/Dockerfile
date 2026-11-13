# vBPF agent: bpftrace runner with the minimal tracing capability set
# (BPF, PERFMON, SYS_RESOURCE — see docker-compose.yml). The port is
# never published to the host; the API reaches it over the compose network.
FROM golang:1.27.0-bookworm@sha256:ded31c68586d2e49e760acc2e65a884b23d032e9bbbed0ae0c55abd3fcaf4452 AS builder

# Release tag (v0.3.0); injected into the agent --version output. Defaults
# to "dev" for local and CI builds that pass no build arg.
ARG VERSION=dev

WORKDIR /src
COPY agent/go.mod agent/go.sum ./
RUN go mod download
COPY agent/cmd ./cmd
COPY agent/internal ./internal
RUN CGO_ENABLED=0 go build -trimpath -ldflags "-X main.version=$VERSION" -o /out/agent ./cmd/agent

FROM ubuntu:25.10@sha256:7cc5e35f6567ee8c66d2abb4aab0fd866669e6207c237c3a8f0947a5c7f17092

RUN for i in 1 2 3 4 5; do \
    if apt-get update; then break; fi; \
    if [ "$i" -eq 5 ]; then exit 1; fi; \
    echo "apt-get update failed (attempt $i/5), retrying in 10s..."; \
    sleep 10; \
  done \
  && apt-get install -y --no-install-recommends bpftrace ca-certificates curl \
  && rm -rf /var/lib/apt/lists/*

COPY --from=builder /out/agent /usr/local/bin/agent

ENV AGENT_TOKEN_FILE=/token/agent.token

EXPOSE 8787

HEALTHCHECK --interval=10s --timeout=5s --start-period=60s --retries=3 \
  CMD curl -sf -H "Authorization: Bearer $(cat /token/agent.token)" http://127.0.0.1:8787/health || exit 1

ENTRYPOINT ["/usr/local/bin/agent"]
CMD ["serve", "--addr", "0.0.0.0:8787", "--token-file", "/token/agent.token"]
