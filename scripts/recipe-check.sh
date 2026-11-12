#!/usr/bin/env bash
# Per-recipe gate (I-19): schema, static rules, dry-run, fixture presence.
# Usage: scripts/recipe-check.sh <id>  (or: make recipe-check ID=<id>)
# Dry-run needs bpftrace; without it that step reports SKIP and the rest
# still runs. Template files (recipes/_*) are never checked: scaffold first
# with scripts/new-recipe.sh.
set -euo pipefail

usage() {
  printf 'usage: %s <id>\n' "$(basename "$0")" >&2
}

die() {
  printf 'recipe-check: %s\n' "$*" >&2
  exit 1
}

[ "$#" -eq 1 ] || { usage; exit 2; }
id="$1"

case "$id" in
  '' | *[^a-z0-9-]* | -* | *- | _*)
    die "invalid recipe id: $id"
    ;;
esac

repo="$(cd "$(dirname "$0")/.." && pwd)"
bt="$repo/recipes/$id.bt"
yaml="$repo/recipes/$id.yaml"
fixture="$repo/fixtures/$id.ndjson"
[ -f "$yaml" ] || die "missing recipes/$id.yaml"
[ -f "$bt" ] || die "missing recipes/$id.bt"

if ! python3 -c 'import yaml, jsonschema' >/dev/null 2>&1; then
  die "missing python packages (pyyaml, jsonschema)"
fi

export RECIPE_ID="$id" RECIPE_REPO="$repo"
python3 - <<'EOF'
import json
import os
import re
import sys
from pathlib import Path

repo = Path(os.environ["RECIPE_REPO"])
rid = os.environ["RECIPE_ID"]
errors = []

doc = __import__("yaml").safe_load((repo / "recipes" / f"{rid}.yaml").read_text())
schema = json.loads((repo / "recipes" / "recipe.schema.json").read_text())
try:
    __import__("jsonschema").validate(doc, schema)
except __import__("jsonschema").ValidationError as e:
    errors.append(f"schema: {e.message}")
if isinstance(doc, dict) and doc.get("id") != rid:
    errors.append(f"id {doc.get('id')!r} != filename")
if isinstance(doc, dict) and not (repo / "recipes" / f"{rid}.bt").is_file():
    errors.append(f"missing recipes/{rid}.bt")

# Static rules mirror the agent validator's lexical gate (the Go suite and
# the agent itself stay authoritative): no blocked calls, no preprocessor
# lines. Comments and string literals are stripped first so prose and
# examples cannot trip the scan.
src = (repo / "recipes" / f"{rid}.bt").read_text()
stripped = re.sub(r'"(?:[^"\\]|\\.)*"', '""', src)
stripped = re.sub(r"/\*.*?\*/", " ", stripped, flags=re.S)
stripped = "\n".join(
    line.split("//", 1)[0] for line in stripped.splitlines()
)
for call in ("system", "signal", "override", "cat"):
    if re.search(rf"\b{call}\s*\(", stripped):
        errors.append(f"blocked call: {call}")
for lineno, line in enumerate(src.splitlines(), 1):
    if re.match(r"\s*#", line):
        errors.append(f"preprocessor line {lineno}")

if errors:
    print("recipe-check: FAILED", file=sys.stderr)
    for e in errors:
        print(f"  - {rid}: {e}", file=sys.stderr)
    sys.exit(1)
print(f"recipe-check: ok: schema + static rules ({rid})")
EOF

if [ ! -s "$fixture" ]; then
  die "missing or empty fixtures/$id.ndjson"
fi
printf 'recipe-check: ok: fixture present (%s, %s lines)\n' "fixtures/$id.ndjson" "$(wc -l <"$fixture")"

if command -v bpftrace >/dev/null 2>&1; then
  if [ "$(id -u)" -eq 0 ]; then
    bpftrace -d "$bt" >/dev/null || die "dry-run failed: $bt"
    printf 'recipe-check: ok: dry-run (%s)\n' "recipes/$id.bt"
  else
    printf 'recipe-check: SKIP: dry-run needs root (bpftrace loads BTF)\n'
  fi
else
  printf 'recipe-check: SKIP: dry-run needs bpftrace\n'
fi

printf 'recipe-check: PASS (%s)\n' "$id"
