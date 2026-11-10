# vBPF agent: privileged bpftrace runner. Must run as root with host PID
# namespace and debugfs/tracefs mounts (see docker-compose.yml). The port is
# never published to the host; the API reaches it over the compose network.
FROM golang:1.27-bookworm AS builder

WORKDIR /src
COPY agent/go.mod agent/go.sum ./
RUN go mod download
COPY agent/cmd ./cmd
COPY agent/internal ./internal
RUN CGO_ENABLED=0 go build -trimpath -o /out/agent ./cmd/agent

FROM ubuntu:24.04

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
