#!/usr/bin/env bash
# Collect a kernel/platform compatibility report (I-12).
# Gathers kernel, distro, bpftrace, BTF, and per-recipe probe availability,
# plus caller-supplied test outcomes, and writes compat/<env>.json.
# Missing BTF/probes are recorded as findings, never as failures: this script
# exits 0 once the report is written. Only usage and environment errors
# (missing python3, unwritable output dir) exit nonzero.
#
# Usage: scripts/collect-compat.sh <env> [--out DIR] [--status S]
#        [--notes TEXT] [--pass LABEL]... [--fail LABEL]...
set -euo pipefail

usage() {
  printf 'usage: %s <env> [--out DIR] [--status S] [--notes TEXT] [--pass LABEL]... [--fail LABEL]...\n' "$(basename "$0")" >&2
}

die() {
  printf 'collect-compat: %s\n' "$*" >&2
  exit 1
}

[ "$#" -ge 1 ] || { usage; exit 2; }
env_name="$1"
shift
case "$env_name" in
  '' | *[^a-z0-9+._-]* | [!a-z0-9]*)
    die "invalid env (want compat/<env>.json key): $env_name"
    ;;
esac

repo="$(cd "$(dirname "$0")/.." && pwd)"
out_dir="$repo/compat"
status="${COMPAT_STATUS:-verified}"
notes="${COMPAT_NOTES:-}"
passes=()
fails=()

while [ "$#" -gt 0 ]; do
  case "$1" in
    --out) [ "$#" -ge 2 ] || { usage; exit 2; }; out_dir="$2"; shift 2 ;;
    --status) [ "$#" -ge 2 ] || { usage; exit 2; }; status="$2"; shift 2 ;;
    --notes) [ "$#" -ge 2 ] || { usage; exit 2; }; notes="$2"; shift 2 ;;
    --pass) [ "$#" -ge 2 ] || { usage; exit 2; }; passes+=("$2"); shift 2 ;;
    --fail) [ "$#" -ge 2 ] || { usage; exit 2; }; fails+=("$2"); shift 2 ;;
    -h | --help) usage; exit 0 ;;
    *) die "unknown flag: $1" ;;
  esac
done

case "$status" in
  verified | unverified | not-run) ;;
  *) die "invalid status (want verified|unverified|not-run): $status" ;;
esac

command -v python3 >/dev/null || die "python3 not found"
[ -d "$out_dir" ] || die "output dir missing: $out_dir"
[ -d "$repo/recipes" ] || die "recipes dir missing"

kernel="${COMPAT_KERNEL:-$(uname -r)}"
if [ -n "${COMPAT_DISTRO:-}" ]; then
  distro="$COMPAT_DISTRO"
elif [ -r /etc/os-release ]; then
  distro="$(grep '^PRETTY_NAME=' /etc/os-release | cut -d= -f2- | tr -d '"' || true)"
  [ -n "$distro" ] || distro="unknown"
else
  distro="unknown"
fi
if command -v bpftrace >/dev/null 2>&1; then
  bpftrace_version="$(bpftrace --version 2>/dev/null | head -n 1 | tr -d '\r\n' || true)"
  [ -n "$bpftrace_version" ] || bpftrace_version="bpftrace (version unknown)"
else
  bpftrace_version="n/a"
fi
if [ -e /sys/kernel/btf/vmlinux ]; then btf="true"; else btf="false"; fi
recorded_at="$(date -u +%F)"

# Candidate libc paths for resolving uprobe:libc:<sym> listings, which
# `bpftrace -l` never enumerates under the bare alias.
libc_paths() {
  if command -v ldconfig >/dev/null 2>&1; then
    ldconfig -p 2>/dev/null | awk '/libc\.so/{print $NF}' | sort -u || true
  fi
  printf '%s\n' /lib/x86_64-linux-gnu/libc.so.6 /usr/lib/x86_64-linux-gnu/libc.so.6 /lib64/libc.so.6
}

probe_present() {
  probe="$1"
  out=""
  if command -v bpftrace >/dev/null 2>&1; then
    out="$(bpftrace -l "$probe" 2>/dev/null || true)"
  fi
  if [ -n "$out" ]; then return 0; fi
  case "$probe" in
    uprobe:libc:*)
      sym="${probe#uprobe:libc:}"
      while IFS= read -r lib; do
        [ -n "$lib" ] || continue
        out="$(bpftrace -l "uprobe:$lib:$sym" 2>/dev/null || true)"
        if [ -n "$out" ]; then return 0; fi
      done <<<"$(libc_paths)"
      ;;
  esac
  return 1
}

# requires: may be flow style on one line or start on the next line.
requires_for() {
  awk '/^requires:/{flag=1} flag{printf "%s ", $0} flag && /\]/{exit}' "$1" |
    sed 's/.*requires: *//; s/\[//; s/\].*//; s/"//g; s/,/ /g'
}

recipe_statuses=""
for yaml in "$repo"/recipes/*.yaml; do
  [ -f "$yaml" ] || continue
  id="$(basename "$yaml" .yaml)"
  case "$id" in
    '' | *[^a-z0-9-]* | -* | *-) die "invalid recipe id: $id" ;;
  esac
  # Intentional word splitting: requires_for emits one probe per word.
  # shellcheck disable=SC2046
  set -- $(requires_for "$yaml")
  [ "$#" -ge 1 ] || die "no requires for recipe: $id"
  available=0
  total=0
  for probe in "$@"; do
    total=$((total + 1))
    if probe_present "$probe"; then available=$((available + 1)); fi
  done
  if [ "$available" -eq "$total" ]; then state="available"; else state="unavailable"; fi
  recipe_statuses+="$id=$state"$'\n'
done
[ -n "$recipe_statuses" ] || die "no recipes found"

export COMPAT_ENV="$env_name" COMPAT_OUT="$out_dir/$env_name.json"
export COMPAT_KERNEL_V="$kernel" COMPAT_DISTRO_V="$distro"
export COMPAT_BPFTRACE_V="$bpftrace_version" COMPAT_BTF="$btf"
export COMPAT_STATUS_V="$status" COMPAT_RECORDED_AT="$recorded_at" COMPAT_NOTES_V="$notes"
export COMPAT_RECIPES="$recipe_statuses"
# Newline-joined labels survive spaces, parens, and commas in test names.
COMPAT_PASSED="$(printf '%s\n' "${passes[@]:-}")"
COMPAT_FAILED="$(printf '%s\n' "${fails[@]:-}")"
export COMPAT_PASSED COMPAT_FAILED

python3 - <<'EOF'
import json
import os

def labels(raw):
    return [line for line in raw.splitlines() if line.strip()]

recipes = {}
for line in os.environ["COMPAT_RECIPES"].splitlines():
    if not line.strip():
        continue
    rid, state = line.rsplit("=", 1)
    recipes[rid] = state

report = {
    "env": os.environ["COMPAT_ENV"],
    "status": os.environ["COMPAT_STATUS_V"],
    "kernel": os.environ["COMPAT_KERNEL_V"],
    "distro": os.environ["COMPAT_DISTRO_V"],
    "bpftrace_version": os.environ["COMPAT_BPFTRACE_V"][:64],
    "btf": os.environ["COMPAT_BTF"] == "true",
    "recorded_at": os.environ["COMPAT_RECORDED_AT"],
    "recipes": dict(sorted(recipes.items())),
    "tests": {
        "passed": labels(os.environ["COMPAT_PASSED"]),
        "failed": labels(os.environ["COMPAT_FAILED"]),
    },
    "notes": os.environ["COMPAT_NOTES_V"],
}
with open(os.environ["COMPAT_OUT"], "w", encoding="utf-8") as fh:
    json.dump(report, fh, indent=2)
    fh.write("\n")
print(f"collect-compat: wrote {os.environ['COMPAT_OUT']}")
EOF
