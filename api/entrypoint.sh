#!/bin/sh
# API entrypoint: the server must run as the non-root node user, but the
# agent token volume is a root-owned 0600 file (the agent enforces 0600).
# Stage a node-owned copy while still root, then re-exec the server as the
# non-root node user (no root PID 1 left behind).
set -eu
TOKEN_DST=/run/vbpf/agent.token
if [ -r /token/agent.token ]; then
  mkdir -p "$(dirname "$TOKEN_DST")"
  install -o node -g node -m 0600 /token/agent.token "$TOKEN_DST"
  AGENT_TOKEN_FILE="$TOKEN_DST"
  export AGENT_TOKEN_FILE
fi
exec setpriv --reuid=node --regid=node --clear-groups -- "$@"
