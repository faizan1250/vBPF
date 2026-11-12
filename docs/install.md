# Install

Three install paths, cheapest first. All three need Linux kernel 5.8+
with BTF and bpftrace 0.20+; root is required only for the agent (it
drives bpftrace). Recipe-only mode works with no provider key; AI
generation needs a provider key in `.env` (see `LLM_PROVIDER_CHAIN` in
`.env.example`). Every release ships checksums, SPDX SBOMs, SLSA build
provenance, and keyless signatures — verify before trusting (last
section). Hardening details live in [deployment](deployment.md) and
[security](security.md).

## 1. Compose (recommended)

Needs Docker with the compose plugin. From the repo root:

```sh
cp .env.example .env
scripts/quickstart.sh
```

The script waits until the `agent`, `api`, and `web` services are
healthy, then prints the URLs. The UI lands on `http://localhost:5173`
(`WEB_PORT` overrides the host port); the API answers on port 8080
inside the compose network and the agent listens on port 8787 on the
compose network only — neither publishes a host port. Health:

```sh
curl -s http://localhost:5173/api/health
docker compose ps
```

Upgrade: `git pull`, then `docker compose up --build -d`. Data (runs,
sessions) persists in the compose `api-data` volume.

## 2. Agent binary plus systemd (single host, no containers)

For hosts that already run bpftrace and want the agent natively while
keeping the API/web on the same host (run from source, §3 — not the
stock compose stack). Download
`agent-linux-amd64` (or `agent-linux-arm64`) plus `sha256sums.txt`
and its signature bundle from a `v*` tag's release assets, then verify
(see the verification section) and check the version:

```sh
./agent-linux-amd64 --version
```

Install following [vbpf-agent.service](../deploy/vbpf-agent.service)
(the unit file header lists the same steps):

```sh
sudo useradd -r -s /usr/sbin/nologin vbpf-agent
sudo install -m 0755 agent-linux-amd64 /usr/local/bin/agent
openssl rand -hex 32 | sudo install -m 0600 -o vbpf-agent -g vbpf-agent /dev/stdin /run/vbpf/agent.token
sudo install -m 0644 deploy/vbpf-agent.service /etc/systemd/system/vbpf-agent.service
sudo systemctl daemon-reload
sudo systemctl enable --now vbpf-agent
```

The unit runs `agent serve --addr 127.0.0.1:8787 --token-file
/run/vbpf/agent.token` as the `vbpf-agent` user with only the tracing
capability retain set. Point a same-host API at it with `AGENT_URL` and
`AGENT_TOKEN_FILE` in `.env` (the compose API defaults already assume
the container agent). The stock compose file hard-codes
`AGENT_URL=http://agent:8787` and the token mount, so overriding `.env`
alone does not repoint a containerized API — that setup needs a compose
override that points `AGENT_URL` at the host and bind-mounts the host
token file in.
Browser clients stay refused unless `AGENT_ALLOWED_ORIGINS` names the
exact UI origin.

## 3. Build from source

Needs Go 1.26+, Node 22 with pnpm 9+, and the Linux requirements
above. From the repo root:

```sh
pnpm install --frozen-lockfile
make agent-build
```

`make agent-build` writes `bin/agent`; it reports `dev` for
`--version` unless built with `-ldflags "-X main.version=..."` (the
release workflow passes the tag). Run it the same way the unit does:

```sh
bin/agent serve --addr 127.0.0.1:8787 --token-file ./run/agent.token
```

`BPFTRACE_PATH` overrides the bpftrace binary for tests and demos
without a system install. API and web run from source with the repo's
dev commands (`HOST` defaults to loopback, `PORT` to 8080); see
[deployment](deployment.md) for the proxy and hardening settings that
apply when exposing them past loopback.

## Verify a release

Every `v*` release attaches the binaries, `sha256sums.txt`, the SPDX
SBOMs (`sbom-agent-binaries.spdx.json` plus per-image SBOMs), and a
Sigstore bundle for the checksums file. The images
(`ghcr.io/faizan1250/vbpf-agent|api|web`, `version` and `latest` tags)
carry keyless signatures and SLSA provenance from the release
workflow. What each file proves is spelled out in
[supply-chain](supply-chain.md).

```sh
sha256sum -c sha256sums.txt
cosign verify-blob --bundle sha256sums.txt.bundle sha256sums.txt \
  --certificate-identity-regexp 'https://github.com/faizan1250/vBPF' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com
cosign verify ghcr.io/faizan1250/vbpf-agent:v0.3.0 \
  --certificate-identity-regexp 'https://github.com/faizan1250/vBPF' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com
```

(substitute the tag from [CHANGELOG](../CHANGELOG.md) for `v0.3.0`).
A failed checksum or signature means the download is corrupt or not
from this project's release workflow — do not install it.
