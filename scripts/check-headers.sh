#!/bin/sh
# Check the web front door serves the expected security headers.
# Usage: scripts/check-headers.sh [base-url]
# Fails non-zero on the first missing header.
set -eu
BASE="${1:-http://localhost:5173}"
missing=0
for header in \
  "x-content-type-options" \
  "x-frame-options" \
  "referrer-policy" \
  "content-security-policy" \
  "permissions-policy"; do
  if curl -sfSI "$BASE/" | grep -qi "^$header:"; then
    echo "ok: $header"
  else
    echo "MISSING: $header" >&2
    missing=1
  fi
done
if curl -sfSI "$BASE/" | grep -qi '^server: nginx/[0-9]'; then
  echo "LEAK: server version banner exposed" >&2
  missing=1
else
  echo "ok: no version banner"
fi
exit $missing
