#!/usr/bin/env bash
# vBPF R-24 demo GIF: fixture-mode UI walkthrough, recorded with Playwright.
# No root, no agent, no network beyond loopback; all charts are synthetic
# fixture replay, so no real paths, usernames, or keys can appear on screen.
set -euo pipefail

cd "$(dirname "$0")/.."

PORT="${DEMO_PORT:-5173}"
OUT="docs/assets/demo.gif"
MAX_BYTES=8388608 # 8 MB

fail() {
  printf 'make-demo: %s\n' "$*" >&2
  exit 1
}

command -v node >/dev/null || fail "node not found"
command -v pnpm >/dev/null || fail "pnpm not found"
command -v ffmpeg >/dev/null || fail "ffmpeg not found (install it, then re-run)"
command -v ffprobe >/dev/null || fail "ffprobe not found (ships with ffmpeg)"

# Playwright bundles its own chromium + ffmpeg; install the browser once.
if [ -z "$(ls "${PLAYWRIGHT_BROWSERS_PATH:-$HOME/.cache/ms-playwright}"/chromium-* 2>/dev/null)" ]; then
  printf 'make-demo: installing playwright chromium...\n'
  pnpm -C web exec playwright install chromium || fail "playwright install failed"
fi

printf 'make-demo: building web with VITE_FIXTURE_MODE=1...\n'
VITE_FIXTURE_MODE=1 pnpm -C web run build >/dev/null || fail "fixture build failed"

printf 'make-demo: starting preview server on 127.0.0.1:%s...\n' "$PORT"
pnpm -C web exec vite preview --port "$PORT" --strictPort >/dev/null 2>&1 &
SERVER_PID=$!
cleanup() { kill "$SERVER_PID" 2>/dev/null || true; }
trap cleanup EXIT

for _ in $(seq 1 30); do
  if curl -sf -o /dev/null "http://127.0.0.1:${PORT}/"; then
    break
  fi
  sleep 1
done
curl -sf -o /dev/null "http://127.0.0.1:${PORT}/" || fail "preview server never came up"

printf 'make-demo: recording three fixture scenarios...\n'
rm -rf web/test-results/demo-demo-three-fixture-scenarios-chromium
pnpm -C web exec playwright test -c playwright.demo.config.ts || fail "demo recording failed"

VIDEO="$(find web/test-results/demo-demo-three-fixture-scenarios-chromium -maxdepth 1 -name '*.webm' -printf '%T@ %p\n' 2>/dev/null | sort -rn | head -1 | cut -d' ' -f2-)"
[ -n "$VIDEO" ] && [ -f "$VIDEO" ] || fail "no video captured"

DUR="$(ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "$VIDEO")"
printf 'make-demo: captured %s (%.0fs)\n' "$VIDEO" "$DUR"

mkdir -p docs/assets

render_gif() {
  # $1 width, $2 fps, $3 dither args (rest)
  local width="$1" fps="$2"
  shift 2
  local palette
  palette="$(mktemp)"
  ffmpeg -y -loglevel error -i "$VIDEO" -vf "fps=${fps},scale=${width}:-1:flags=lanczos,palettegen" "$palette"
  ffmpeg -y -loglevel error -i "$VIDEO" -i "$palette" -lavfi \
    "fps=${fps},scale=${width}:-1:flags=lanczos[x];[x][1:v]paletteuse=$*" "$OUT"
  rm -f "$palette"
}

render_gif 640 8 "dither=bayer:bayer_scale=4"
SIZE="$(wc -c <"$OUT")"
if [ "$SIZE" -gt "$MAX_BYTES" ]; then
  printf 'make-demo: %s exceeds 8 MB, retrying smaller...\n' "$(awk "BEGIN { printf \"%.1f MB\", $SIZE / 1048576 }")"
  render_gif 560 7 "dither=bayer:bayer_scale=5"
  SIZE="$(wc -c <"$OUT")"
fi
[ "$SIZE" -le "$MAX_BYTES" ] || fail "demo.gif still exceeds 8 MB ($SIZE bytes)"

printf 'make-demo: wrote %s (%s, %.0fs)\n' "$OUT" "$(awk "BEGIN { printf \"%.1f MB\", $SIZE / 1048576 }")" "$DUR"
