#!/usr/bin/env bash
# Docs truthfulness gate (I-09): documented agent subcommands/flags, env vars,
# make targets, ports, helper scripts, and relative links must match the code.
# Static only: no root, no network, no secrets, no build. Fails non-zero on
# the first mismatch class with details; prints ok lines otherwise.
#
# shellcheck disable=SC2016 # grep patterns below are intentionally
# single-quoted: `$`, backticks, and `${...}` are literals, never expansions.
# Design notes (recorded decisions):
# - Ground truth is derived from the sources, not hardcoded, so the check
#   cannot silently drift from the code: agent flags from
#   agent/cmd/agent/main.go, env keys from api/src/config.ts + .env.example +
#   docker-compose.yml + os.Getenv/env[] literals, make targets from the
#   Makefiles, ports from config defaults + compose.
# - LLM_<NAME>_* entries are templates (one per provider), so any concrete
#   LLM_<PROVIDER>_<SUFFIX> where SUFFIX is a known suffix passes.
# - API error codes (AGENT_OFFLINE, LIMIT_EXCEEDED, ...) are status strings,
#   not env vars; they pass via an explicit allowlist below.
# - docs/decisions.md is an append-only dated log: it may quote old numbers
#   and superseded commands on purpose. Links are still checked there, but
#   claim checks (flags/env/make/ports/scripts) skip it.
set -euo pipefail

cd "$(dirname "$0")/.."

failures=0
fail() { printf 'check-docs: FAIL: %s\n' "$*" >&2; failures=$((failures + 1)); }
section_ok() { [ "$failures" = "$1" ] && printf 'check-docs: ok: %s\n' "$2" || true; }

# Normative docs for claim checks; every tracked markdown file for links.
if git rev-parse --show-toplevel >/dev/null 2>&1; then
  ALL_MD="$(git ls-files 'README.md' 'CONTRIBUTING.md' 'docs/*.md')"
else
  ALL_MD="$(ls README.md CONTRIBUTING.md docs/*.md 2>/dev/null)"
fi
CLAIM_MD="$(printf '%s\n' "$ALL_MD" | grep -v '^docs/decisions\.md$' || true)"
if [ -z "$CLAIM_MD" ]; then
  fail "no markdown docs found"
  exit 1
fi

# --- Ground truth: agent CLI ---------------------------------------------
# Subcommands from the usage strings; flags from the "--flag" literals.
AGENT_USAGE="$(grep -h 'usage: agent' agent/cmd/agent/main.go || true)"
agent_before=$failures
case "$AGENT_USAGE" in
  *"<run|serve>"*) section_ok "$agent_before" "agent subcommands are run|serve" ;;
  *) fail "agent usage line changed, update check and docs: $AGENT_USAGE" ;;
esac
AGENT_FLAGS="$(grep -o '"--[a-z-]*"' agent/cmd/agent/main.go | tr -d '"' | sort -u)"
EVAL_FLAGS="$(grep -o '"--[a-z-]*"' api/src/eval.ts | tr -d '"' | sort -u)"
[ -n "$AGENT_FLAGS" ] || fail "no agent flags extracted from main.go"
[ -n "$EVAL_FLAGS" ] || fail "no eval flags extracted from eval.ts"

# Flags documented next to an agent invocation must exist.
while IFS= read -r line; do
  flags="$(printf '%s' "$line" | grep -o '\-\-[a-z-][a-z-]*' || true)"
  for f in $flags; do
    [ "$f" = "--" ] && continue
    if ! printf '%s\n' "$AGENT_FLAGS" | grep -qx -- "$f"; then
      fail "agent flag $f not in agent CLI (line: $line)"
    fi
  done
done <<EOF
$(printf '%s\n' "$CLAIM_MD" | xargs grep -h -e 'bin/agent' -e 'dev-agent\.sh' -e 'agent serve' -e 'agent run' 2>/dev/null || true)
EOF
stop_before=$failures
if printf '%s\n' "$CLAIM_MD" | xargs grep -h -o 'agent `stop`\|agent stop' 2>/dev/null | grep -q .; then
  fail "docs claim an 'agent stop' subcommand, but the CLI has only run|serve"
else
  section_ok "$stop_before" "no documented 'agent stop' subcommand"
fi

# --- Ground truth: env vars ----------------------------------------------
ENV_TRUTH="$(
  {
    grep -o '^[A-Z][A-Z0-9_]*=' .env.example 2>/dev/null | tr -d '='
    grep -o '^    [A-Z][A-Z0-9_]*:' api/src/config.ts 2>/dev/null | tr -d ' :'
    grep -o '^[A-Z][A-Z0-9_]*:' docker-compose.yml 2>/dev/null | tr -d ':'
    grep -o '\${[A-Z][A-Z0-9_]*}' docker-compose.yml 2>/dev/null | tr -d '${}'
    grep -o '\${[A-Z][A-Z0-9_]*:-' docker-compose.yml 2>/dev/null | tr -d '${:-'
    grep -ho '^[A-Z][A-Z0-9_]* *?*=' Makefile eval/Makefile 2>/dev/null | sed 's/[ ?=].*//'
    grep -rho '"[A-Z][A-Z0-9_]*"' agent --include='*.go' 2>/dev/null | tr -d '"'
    grep -rho 'env\["[A-Z][A-Z0-9_]*"\]' api/src web/src 2>/dev/null | grep -o '"[A-Z][A-Z0-9_]*"' | tr -d '"'
    printf 'PORT\nHOST\n'
  } | sort -u
)"
[ -n "$ENV_TRUTH" ] || fail "no env ground truth extracted"

# Status/error codes are not env vars; documented freely, never configured.
CODE_ALLOW='AGENT_NOT_READY|AGENT_OFFLINE|BLOCKED_CALL|CATALOG_UNAVAILABLE|FORBIDDEN|INTERNAL_ERROR|KERNEL_UNSUPPORTED|LIMIT_EXCEEDED|LLM_ERROR|LLM_UNAVAILABLE|NO_PRIVILEGE|NOT_FOUND|PROBE_ARGS_FAILED|PROBE_NOT_FOUND|RATE_LIMITED|UNAUTHORIZED|UNKNOWN_CALL|UPROBE_TARGET_INVALID|VALIDATION_FAILED|WILDCARD_INVALID'
# Provider-template instances: LLM_<PROVIDER>_<SUFFIX>.
SUFFIX_ALLOW='MODEL|FALLBACK_MODELS|JSON_MODE|BASE_URL|API_KEY'
# Toolchain vars mentioned in passing, not project config.
TOOL_ALLOW='GOOS|GOARCH|GOTOOLCHAIN'

check_env_token() {
  tok="$1"
  where="$2"
  case "$tok" in
    LLM_*)
      rest="${tok#LLM_}"
      suffix="${rest##*_}"
      if printf '%s' "$SUFFIX_ALLOW" | tr '|' '\n' | grep -qx -- "$suffix"; then
        return 0
      fi
      ;;
  esac
  if printf '%s\n' "$ENV_TRUTH" | grep -qx -- "$tok"; then
    return 0
  fi
  if printf '%s' "$CODE_ALLOW" | tr '|' '\n' | grep -qx -- "$tok"; then
    return 0
  fi
  if printf '%s' "$TOOL_ALLOW" | tr '|' '\n' | grep -qx -- "$tok"; then
    return 0
  fi
  fail "env var $tok not in code/.env/compose ($where)"
}

env_before=$failures
while IFS= read -r tok; do
  # Only tokens in the project's env namespaces are candidates.
  case "$tok" in
    AGENT_*|LLM_*|BPFTRACE_*|TRUST_PROXY|WEB_*|DATABASE_*|RECIPES_*|MAX_DURATION_*|DEFAULT_DURATION_*|VITE_*|NODE_ENV|FUZZ_TIME|TOKEN_FILE|GOOS|GOARCH|GOTOOLCHAIN) ;;
    *) continue ;;
  esac
  loc="$(printf '%s\n' "$CLAIM_MD" | xargs grep -h -l -- "$tok" 2>/dev/null | tr '\n' ' ')"
  check_env_token "$tok" "$loc"
done <<EOF
$(printf '%s\n' "$CLAIM_MD" | xargs grep -hoE '\b[A-Z][A-Z0-9]*(_[A-Z0-9]+)+\b' 2>/dev/null | sort -u || true)
EOF
section_ok "$env_before" "documented env vars exist in code/.env/compose"

# --- Ground truth: make targets -------------------------------------------
make_before=$failures
MAKE_TARGETS="$(grep -oE '^[a-z][a-z0-9-]*:' Makefile | tr -d ':' | sort -u)"
EVAL_MAKE_TARGETS="$(grep -oE '^[a-z][a-z0-9-]*:' eval/Makefile | tr -d ':' | sort -u)"
[ -n "$MAKE_TARGETS" ] || fail "no make targets extracted from Makefile"
# Documented `make [target]` / `make -C [dir] [target]` refs must exist.
# Prose like "make focused commits" is skipped: a target ref must not be
# followed by a space plus a lowercase word.
while IFS= read -r line; do
  rest="$line"
  while case "$rest" in *'make '*) true;; *) false;; esac; do
    rest="${rest#*make }"
    dir=""
    case "$rest" in
      -C\ *)
        rest="${rest#-C }"
        dir="${rest%% *}"
        rest="${rest#* }"
        ;;
    esac
    tgt="$(printf '%s' "$rest" | grep -oE '^[a-z][a-z0-9-]+' || true)"
    [ -n "$tgt" ] || continue
    after="${rest#"$tgt"}"
    rest="$after"
    case "$after" in
      ' '[a-z]*) continue ;; # prose ("make focused commits"), not a ref
    esac
    if [ -n "$dir" ]; then
      case "$dir" in
        eval) pool="$EVAL_MAKE_TARGETS" ;;
        *) fail "make -C $dir references unknown Makefile dir"; continue ;;
      esac
    else
      pool="$MAKE_TARGETS"
    fi
    if ! printf '%s\n' "$pool" | grep -qx -- "$tgt"; then
      fail "make target '$tgt' not found (line: $line)"
    fi
  done
done <<EOF
$(printf '%s\n' "$CLAIM_MD" | xargs grep -h 'make ' 2>/dev/null || true)
EOF
section_ok "$make_before" "documented make targets exist"

# --- Ground truth: ports ---------------------------------------------------
ports_before=$failures
# Reserved loopback ports; 18080 is the documented workload scratch port.
PORT_ALLOW='5173|8080|8787|18080'
while IFS= read -r p; do
  if ! printf '%s' "$PORT_ALLOW" | tr '|' '\n' | grep -qx -- "$p"; then
    fail "port $p documented but not a reserved port (want 5173/8080/8787)"
  fi
done <<EOF
$(printf '%s\n' "$CLAIM_MD" | xargs grep -hoE '(localhost|127\.0\.0\.1|\[::1\]):[0-9]{2,5}' 2>/dev/null | grep -oE '[0-9]{2,5}$' | sort -u || true)
EOF
grep -q 'default(8080)' api/src/config.ts || grep -q 'PORT.*default(8080)' api/src/config.ts || fail "API default port is not 8080 in config.ts"
grep -q '127.0.0.1:8787' agent/cmd/agent/main.go || fail "agent default addr is not 127.0.0.1:8787 in main.go"
grep -q '127.0.0.1:${WEB_PORT:-5173}:8080' docker-compose.yml || fail "compose does not publish only 127.0.0.1:5173->8080"
section_ok "$ports_before" "documented ports match code and compose defaults"

# --- Helper scripts ---------------------------------------------------------
scripts_before=$failures
while IFS= read -r s; do
  [ -f "$s" ] || fail "documented helper $s does not exist"
done <<EOF
$(printf '%s\n' "$CLAIM_MD" | xargs grep -hoE 'scripts/[a-z0-9-]+\.sh' 2>/dev/null | sort -u || true)
EOF
section_ok "$scripts_before" "documented helper scripts exist"

# --- Relative links (all tracked markdown, including the decision log) -----
links_before=$failures
slugify() { printf '%s' "$1" | tr '[:upper:]' '[:lower:]' | sed -e 's/[^a-z0-9 _-]//g' -e 's/ /-/g'; }
while IFS= read -r md; do
  dir="$(dirname "$md")"
  while IFS= read -r link; do
    case "$link" in
      http*|mailto:*|'#'*) continue ;;
    esac
    file="${link%%#*}"
    anchor="${link#*#}"
    [ "$file" = "$link" ] && anchor=""
    target="$file"
    case "$file" in
      "") target="$md" ;;
      /*) continue ;; # absolute web path, not a repo file
      *) target="$dir/$file" ;;
    esac
    # README links are repo-root-relative; docs/ links are dir-relative.
    if [ ! -e "$target" ] && [ -e "$file" ]; then
      target="$file"
    fi
    [ -e "$target" ] || { fail "broken link in $md: $link"; continue; }
    if [ -n "$anchor" ]; then
      headers="$(grep -E '^#{1,6} ' "$target" 2>/dev/null | sed -E 's/^#{1,6} //' | sed -E 's/^\s+|\s+$//g' || true)"
      found=0
      while IFS= read -r h; do
        if [ "$(slugify "$h")" = "$anchor" ]; then found=1; break; fi
      done <<< "$headers"
      [ "$found" = 1 ] || fail "broken anchor in $md: $link"
    fi
  done <<EOF
$(grep -oE '\]\([^)]+\)' "$md" | sed -e 's/^](//' -e 's/)$//' | sort -u || true)
EOF
done <<EOF
$ALL_MD
EOF
section_ok "$links_before" "relative links resolve"

if [ "$failures" -gt 0 ]; then
  printf 'check-docs: %d mismatch(es) found\n' "$failures" >&2
  exit 1
fi
printf 'check-docs: PASS (agent flags, env vars, make targets, ports, scripts, links)\n'
