#!/usr/bin/env bash
set -euo pipefail

printf 'fake-bpftrace: args ignored (mock-only)\n' >&2
printf 'fake-probe cpu=0 pid=1 comm="init" latency_us=7\n'
