#!/usr/bin/env bash
# Scaffold a new recipe from recipes/_template.bt + recipes/_template.yaml.
# Usage: scripts/new-recipe.sh <id>
# Next: edit the .bt probes, fill in the .yaml, capture fixtures/<id>.ndjson,
# then run: make recipe-check ID=<id> (see docs/writing-recipes.md).
set -euo pipefail

usage() {
  printf 'usage: %s <id>\n' "$(basename "$0")" >&2
  printf '  id: lowercase letters, digits, hyphens; no leading/trailing hyphen\n' >&2
}

die() {
  printf 'new-recipe: %s\n' "$*" >&2
  exit 1
}

[ "$#" -eq 1 ] || { usage; exit 2; }
id="$1"

case "$id" in
  '' | *[^a-z0-9-]* | -* | *-)
    die "invalid recipe id: $id"
    ;;
esac

repo="$(cd "$(dirname "$0")/.." && pwd)"
[ -f "$repo/recipes/_template.bt" ] || die "recipes/_template.bt missing"
[ -f "$repo/recipes/_template.yaml" ] || die "recipes/_template.yaml missing"

bt="$repo/recipes/$id.bt"
yaml="$repo/recipes/$id.yaml"
[ -e "$bt" ] && die "already exists: recipes/$id.bt"
[ -e "$yaml" ] && die "already exists: recipes/$id.yaml"

cp "$repo/recipes/_template.bt" "$bt"
sed "s/my-recipe/$id/g" "$repo/recipes/_template.yaml" >"$yaml"

printf 'new-recipe: wrote %s %s\n' "recipes/$id.bt" "recipes/$id.yaml"
printf 'new-recipe: next: edit the probes, fill in the yaml, then run: make recipe-check ID=%s\n' "$id"
