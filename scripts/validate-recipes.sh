#!/usr/bin/env bash
# Validate every recipes/*.yaml against recipes/recipe.schema.json.
# Checks schema conformance, id == filename, that recipes/<id>.bt exists,
# that a captured fixture exists in fixtures/, and the static lexical rules
# (blocked calls, preprocessor lines). Template files (recipes/_*) are
# scaffolding, never recipes, and are skipped. The comment/string-aware
# scan here catches contributor accidents; the Go validator suite and the
# agent itself stay authoritative.
set -euo pipefail

repo="$(cd "$(dirname "$0")/.." && pwd)"

if ! python3 -c 'import yaml, jsonschema' >/dev/null 2>&1; then
  printf 'validate-recipes: missing python packages (pyyaml, jsonschema).\n' >&2
  printf 'Install them with your system package manager or venv, then re-run.\n' >&2
  exit 1
fi

python3 - "$repo" <<'EOF'
import json
import re
import sys
from pathlib import Path

import yaml
import jsonschema

repo = Path(sys.argv[1])
schema = json.loads((repo / "recipes" / "recipe.schema.json").read_text())
errors = []
files = sorted(
    p for p in (repo / "recipes").glob("*.yaml") if not p.name.startswith("_")
)
if not files:
    errors.append("no recipes/*.yaml found")
for path in files:
    doc = yaml.safe_load(path.read_text())
    try:
        jsonschema.validate(doc, schema)
    except jsonschema.ValidationError as e:
        errors.append(f"{path.name}: schema: {e.message}")
        continue
    if not isinstance(doc, dict):
        errors.append(f"{path.name}: top level must be a mapping")
        continue
    if doc.get("id") != path.stem:
        errors.append(f"{path.name}: id {doc.get('id')!r} != filename")
    bt = repo / "recipes" / f"{path.stem}.bt"
    if not bt.is_file():
        errors.append(f"{path.name}: missing recipes/{path.stem}.bt")
        continue
    fixture = repo / "fixtures" / f"{path.stem}.ndjson"
    if not fixture.is_file() or fixture.stat().st_size == 0:
        errors.append(f"{path.name}: missing or empty fixtures/{path.stem}.ndjson")
    src = bt.read_text()
    stripped = re.sub(r'"(?:[^"\\]|\\.)*"', '""', src)
    stripped = re.sub(r"/\*.*?\*/", " ", stripped, flags=re.S)
    stripped = "\n".join(
        line.split("//", 1)[0] for line in stripped.splitlines()
    )
    for call in ("system", "signal", "override", "cat"):
        if re.search(rf"\b{call}\s*\(", stripped):
            errors.append(f"{path.stem}.bt: blocked call: {call}")
    for lineno, line in enumerate(src.splitlines(), 1):
        if re.match(r"\s*#", line):
            errors.append(f"{path.stem}.bt: preprocessor line {lineno}")
if errors:
    print("validate-recipes: FAILED", file=sys.stderr)
    for e in errors:
        print(f"  - {e}", file=sys.stderr)
    sys.exit(1)
print(f"validate-recipes: OK ({len(files)} recipes)")
EOF
