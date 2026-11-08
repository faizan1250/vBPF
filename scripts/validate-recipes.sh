#!/usr/bin/env bash
# Validate every recipes/*.yaml against recipes/recipe.schema.json.
# Checks schema conformance, id == filename, and that recipes/<id>.bt exists.
set -euo pipefail

repo="$(cd "$(dirname "$0")/.." && pwd)"

if ! python3 -c 'import yaml, jsonschema' >/dev/null 2>&1; then
  printf 'validate-recipes: installing missing python packages...\n' >&2
  if ! python3 -m pip install --user --quiet pyyaml jsonschema >/dev/null 2>&1; then
    python3 -m pip install --user --break-system-packages --quiet pyyaml jsonschema
  fi
fi

python3 - "$repo" <<'EOF'
import json
import sys
from pathlib import Path

import yaml
import jsonschema

repo = Path(sys.argv[1])
schema = json.loads((repo / "recipes" / "recipe.schema.json").read_text())
errors = []
files = sorted((repo / "recipes").glob("*.yaml"))
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
    if not (repo / "recipes" / f"{path.stem}.bt").is_file():
        errors.append(f"{path.name}: missing recipes/{path.stem}.bt")
if errors:
    print("validate-recipes: FAILED", file=sys.stderr)
    for e in errors:
        print(f"  - {e}", file=sys.stderr)
    sys.exit(1)
print(f"validate-recipes: OK ({len(files)} recipes)")
EOF
