#!/usr/bin/env bash
# Paste-ready kernel compatibility report for .github/ISSUE_TEMPLATE/kernel.yml.
# Usage: scripts/compat-report.sh [env]
# Collects kernel, distro, bpftrace version, BTF, and per-recipe probe
# availability into a temp report (see scripts/collect-compat.sh), then
# prints markdown to paste into the issue's Environment and Results fields.
# Exits 0 once the report prints; missing probes are findings, never failures.
set -euo pipefail

usage() {
  printf 'usage: %s [env]\n' "$(basename "$0")" >&2
  printf '  env defaults to "<distro>-<release>" from /etc/os-release\n' >&2
}

die() {
  printf 'compat-report: %s\n' "$*" >&2
  exit 1
}

if [ "$#" -gt 1 ]; then usage; exit 2; fi
case "${1:-}" in -h | --help) usage; exit 0 ;; esac

repo="$(cd "$(dirname "$0")/.." && pwd)"
command -v python3 >/dev/null || die "python3 not found"

if [ "$#" -eq 1 ]; then
  env_name="$1"
else
  env_name="$(grep '^ID=' /etc/os-release 2>/dev/null | cut -d= -f2 | tr -d '"' || true)"
  release="$(grep '^VERSION_ID=' /etc/os-release 2>/dev/null | cut -d= -f2 | tr -d '"' || true)"
  [ -n "$env_name" ] || die "cannot derive env; pass one explicitly"
  env_name="$env_name${release:+-$release}"
fi

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
"$repo/scripts/collect-compat.sh" "$env_name" --out "$tmp" --status unverified \
  --notes "Printed by scripts/compat-report.sh; paste into a kernel report issue." >/dev/null

export COMPAT_JSON="$tmp/$env_name.json"
python3 - <<'EOF'
import json
import os

with open(os.environ["COMPAT_JSON"], encoding="utf-8") as fh:
    rep = json.load(fh)

print("## Environment")
print()
print(f"- Distro: {rep['distro']}")
print(f"- Kernel: `{rep['kernel']}`")
print(f"- BTF present: {'yes' if rep['btf'] else 'no'}")
print(f"- bpftrace: `{rep['bpftrace_version']}`")
print()
print("## Results")
print()
print("| Recipe | Probe status |")
print("| ------ | ------------ |")
for rid, state in rep["recipes"].items():
    print(f"| `{rid}` | {state} |")
EOF
