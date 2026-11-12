# Supply chain

How dependencies, images, actions, scans, and SBOMs are handled.
CI stays mock-only throughout: no provider keys, no network beyond the
public registries the runners already use.

## Pins

- GitHub Actions are pinned to full commit SHAs (`uses: ...@<sha> # vX`);
  the tag rides along as a comment only. `scripts/check-supply-chain.sh`
  (CI `supply-chain` job, plus `actionlint`) fails on any floating ref.
- Container base images are pinned to digests (`image@sha256:...`) in every
  Dockerfile; `docker-compose.yml` inherits them.
- Go and JS toolchains are pinned (`agent/go.mod`, `pnpm` 9.x, Node 22);
  `govulncheck`, `golangci-lint`, and `actionlint` are installed at pinned
  versions in CI.

## Update cadence and review

- `.github/dependabot.yml` opens weekly grouped minor/patch PRs (one
  `chore(deps)` commit each) for npm workspaces, `agent` gomod,
  github-actions, and each Dockerfile. Major bumps are manual.
- Dependabot moves SHA/digest pins in place; the reviewer still verifies
  each PR keeps the pin and passes CI before merging. Only the maintainer
  merges dependency PRs.

## Scanning

- CodeQL (`.github/workflows/codeql.yml`): `javascript-typescript` and `go`
  on push, PR, and weekly. Default query suite.
- OpenSSF Scorecard (`.github/workflows/scorecard.yml`): weekly plus push
  to `main`, SARIF published to code scanning. The README badge lands only
  after the first successful run, so no badge is ever aspirational.
- `govulncheck ./...` (CI `vuln` job, `make vuln`): any known vulnerability
  fails the build; Go findings are fixed, never waived (govulncheck has no
  severity gate, so this is stricter than high/critical).
- `pnpm audit` (CI `audit` job, `make audit` via `scripts/check-audit.mjs`):
  fails on high/critical findings unless each is covered by an unexpired
  `.github/audit-allowlist.json` entry carrying a reason and an expiry date.
  Expired entries fail the gate.
- gitleaks (CI `secrets` job, `make secrets`): any finding fails the build.

## SBOM

- CI (`sbom` job) builds the `agent`, `api`, and `web` images and publishes
  SPDX JSON SBOMs (`sbom-*.spdx.json`) as the `sbom` artifact via the pinned
  `anchore/sbom-action`. The agent image SBOM covers the agent binary.
- The release workflow (I-16, `.github/workflows/release.yml`) reuses the
  same anchore step and attaches the SBOMs to the release next to
  `sha256sums.txt` and the provenance attestations.

## Reporting

Private vulnerability reports only (see `SECURITY.md`); supported line:
latest `0.3.x`. Public scorecard and CodeQL results are visible under the
repository Security tab.
