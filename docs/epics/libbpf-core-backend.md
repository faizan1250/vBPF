# Epic: libbpf CO-RE backend for long-running probes

Tracking: https://github.com/faizan1250/vBPF/issues/146

## Problem

The only backend is bpftrace. Very long-running, low-overhead
observation (always-on counters, high-frequency events with in-kernel
aggregation) wants compiled BPF with CO-RE relocation instead of a
freshly compiled script per run.

## Constraints

- The validator philosophy carries over: small allowlist of probe
  types and helpers, explicit deny list, size caps, no shellout.
- Agent privilege is unchanged: tracing caps only, private temp
  files, process-group teardown.
- The per-agent one-run cap applies to compiled probes too.
- Loopback stays the default bind; nothing in this epic opens a
  new listener.
- CO-RE needs BTF on the target host, so the existing BTF
  readiness check becomes a hard requirement for this backend.

## Phased plan

1. Spike: hand-write one C probe, compile with clang, relocate
   against BTF, load from the agent, and stream its output through
   the existing event path.
2. Template-constrained codegen: the model fills parameters of
   reviewed templates, never free-form C. Templates live beside
   recipes with metadata and tests.
3. Relocation matrix: verify the same object relocates across the
   kernels in the compat matrix, and record per-kernel results.
4. Backend picker: per-run choice of bpftrace or compiled probe,
   with bpftrace remaining the default until parity is proven.
5. Recipe migration: port the steady-state recipes that benefit
   most, keeping bpftrace variants as fallback.

## API and UI touchpoints

- Proposed API additions: a backend field on run creation plus
  template parameters next to the script body. Generate responses
  name the backend and template used.
- Proposed agent additions: object loading, relocation reporting,
  and verifier-error surfacing through the existing dry-run path.
- Web: backend badge in the confirm dialog, per-backend validation
  state, and recipe cards that show both variants where they exist.

## Test strategy

- Unit tests for template rendering and parameter validation,
  including hostile-parameter cases.
- Parity tests: compiled probe output matches the bpftrace recipe
  for the same workload within documented tolerance.
- Real-kernel runs on the matrix kernels; CI keeps stubbed
  validation only, never loading BPF.

## Non-goals

- Free-form C generation from the model.
- Replacing bpftrace as the default backend.
- Probes that bypass the validator or the verifier.
- Continuous always-on deployment; runs keep their duration caps.
