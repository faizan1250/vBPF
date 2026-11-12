#!/usr/bin/env bash
# Supply-chain gate (I-15): Dependabot, CodeQL, Scorecard, SBOM, audit
# allowlist, and SECURITY/supply-chain docs must stay in place and pinned.
# Static only: no root, no network, no secrets, no build. Fails non-zero
# with details; prints ok lines otherwise.
set -euo pipefail

cd "$(dirname "$0")/.."

failures=0
fail() { printf 'check-supply-chain: FAIL: %s\n' "$*" >&2; failures=$((failures + 1)); }
section_ok() { if [ "$failures" = "$1" ]; then printf 'check-supply-chain: ok: %s\n' "$2"; fi; }

# 1. Dependabot covers npm, gomod, github-actions, and docker; weekly;
# grouped minor/patch; chore(deps) prefix.
base=0
[ -f .github/dependabot.yml ] || fail "missing .github/dependabot.yml"
if [ -f .github/dependabot.yml ]; then
  for eco in '"npm"' '"gomod"' '"github-actions"' '"docker"'; do
    grep -q "package-ecosystem: $eco" .github/dependabot.yml \
      || fail "dependabot.yml lacks $eco ecosystem"
  done
  grep -q 'interval: *"weekly"' .github/dependabot.yml \
    || fail "dependabot.yml schedule is not weekly"
  grep -q 'patterns:' .github/dependabot.yml \
    || fail "dependabot.yml has no grouped minor/patch updates"
  grep -q 'prefix: *"chore(deps)"' .github/dependabot.yml \
    || fail "dependabot.yml commit prefix is not chore(deps)"
  grep -q 'directory: *"/agent"' .github/dependabot.yml \
    || fail "dependabot.yml lacks a /agent entry (gomod/docker)"
fi
section_ok "$base" "dependabot config"

# 2. Every `uses:` in every workflow is pinned to a full commit SHA
# (tag may ride along as a comment only).
base=$failures
while IFS= read -r f; do
  while IFS= read -r line; do
    case "$line" in
      *@[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]*) ;;
      *) fail "unpinned action in $f: $line" ;;
    esac
  done < <(grep -h 'uses:' "$f" || true)
done < <(git ls-files '.github/workflows/*.yml' 2>/dev/null || ls .github/workflows/*.yml)
section_ok "$base" "action SHA pins"

# 3. CodeQL covers JavaScript/TypeScript and Go on push, PR, and schedule.
base=$failures
[ -f .github/workflows/codeql.yml ] || fail "missing .github/workflows/codeql.yml"
if [ -f .github/workflows/codeql.yml ]; then
  grep -q 'javascript-typescript' .github/workflows/codeql.yml \
    || fail "codeql.yml lacks javascript-typescript"
  grep -qE '(^|[^a-z-])go([^a-z-]|$)' .github/workflows/codeql.yml \
    || fail "codeql.yml lacks go"
  for trig in 'push:' 'pull_request:' 'schedule:'; do
    grep -q "$trig" .github/workflows/codeql.yml \
      || fail "codeql.yml lacks $trig trigger"
  done
fi
section_ok "$base" "codeql config"

# 4. Scorecard publishes SARIF to code scanning with minimal permissions.
base=$failures
[ -f .github/workflows/scorecard.yml ] || fail "missing .github/workflows/scorecard.yml"
if [ -f .github/workflows/scorecard.yml ]; then
  grep -q 'ossf/scorecard-action' .github/workflows/scorecard.yml \
    || fail "scorecard.yml does not use ossf/scorecard-action"
  grep -q 'results.sarif' .github/workflows/scorecard.yml \
    || fail "scorecard.yml does not keep results.sarif"
  grep -q 'security-events: *write' .github/workflows/scorecard.yml \
    || fail "scorecard.yml lacks security-events: write"
  grep -q 'id-token: *write' .github/workflows/scorecard.yml \
    || fail "scorecard.yml lacks id-token: write"
fi
section_ok "$base" "scorecard config"

# 5. CI defines SBOM, JS audit, and supply-chain gate jobs.
base=$failures
for job in 'sbom:' 'audit:' 'supply-chain:'; do
  grep -q "^  $job" .github/workflows/ci.yml \
    || fail "ci.yml lacks a $job job"
done
grep -q 'anchore/sbom-action' .github/workflows/ci.yml \
  || fail "ci.yml sbom job does not use anchore/sbom-action"
grep -qE 'spdx-json|cyclonedx-json' .github/workflows/ci.yml \
  || fail "ci.yml sbom job names no SPDX/CycloneDX format"
section_ok "$base" "ci sbom/audit jobs"

# 6. Audit allowlist is valid JSON; every entry carries a reason and an
# unexpired expiry date (YYYY-MM-DD).
base=$failures
[ -f .github/audit-allowlist.json ] || fail "missing .github/audit-allowlist.json"
if [ -f .github/audit-allowlist.json ]; then
  node --input-type=module -e "
import { readFileSync } from 'node:fs';
const allow = JSON.parse(readFileSync('.github/audit-allowlist.json', 'utf8'));
if (!Array.isArray(allow.entries)) throw new Error('entries must be an array');
const today = new Date().toISOString().slice(0, 10);
for (const e of allow.entries) {
  if (!e.advisory || !e.reason || !e.expires) throw new Error('entry needs advisory, reason, expires: ' + JSON.stringify(e));
  if (!/^\d{4}-\d{2}-\d{2}$/.test(e.expires)) throw new Error('expires must be YYYY-MM-DD: ' + e.expires);
  if (e.expires < today) throw new Error('expired allowlist entry: ' + e.advisory);
}
" || fail "audit-allowlist.json invalid (schema or expired entry)"
fi
section_ok "$base" "audit allowlist"

# 7. SECURITY.md names the supported line; docs/supply-chain.md exists
# and references each control.
base=$failures
grep -q '0\.3\.x' SECURITY.md || fail "SECURITY.md does not name 0.3.x as supported"
[ -f docs/supply-chain.md ] || fail "missing docs/supply-chain.md"
if [ -f docs/supply-chain.md ]; then
  for topic in 'dependabot' 'codeql' 'scorecard' 'sbom' 'allowlist'; do
    grep -qi "$topic" docs/supply-chain.md \
      || fail "docs/supply-chain.md never mentions $topic"
  done
fi
section_ok "$base" "security docs"

if [ "$failures" -ne 0 ]; then
  printf 'check-supply-chain: %d failure(s)\n' "$failures" >&2
  exit 1
fi
printf 'check-supply-chain: all ok\n'
