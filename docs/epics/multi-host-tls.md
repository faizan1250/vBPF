# Epic: multi-host agents over TLS with fleet scheduler

Tracking: https://github.com/faizan1250/vBPF/issues/145

## Problem

vBPF runs one probe on one host at a time. Teams with more than a
single dev machine cannot trace staging or production hosts, compare
behavior across machines, or queue work while a probe is running.

## Constraints

- The agent keeps only tracing caps and never runs as full root.
  Remote operation must not widen that privilege.
- The per-agent one-run-at-a-time cap stays. Concurrency grows by
  adding agents, never by stacking runs on one agent.
- Loopback remains the default bind. Listening on a routable address
  requires an explicit opt-in plus mutual TLS, and fails closed
  without certificates.
- Every host still needs a supported kernel with BTF, checked at
  agent startup before the agent advertises readiness.
- The bearer-token gate stays; enrollment issues short-lived tokens
  scoped to one agent identity, never a shared cluster secret.

## Phased plan

1. Threat model for remote agents: trust boundaries, enrollment
   ceremony, certificate rotation, and revocation story.
2. Agent TLS listener: certificate files, mutual authentication,
   and the existing token check applied after the handshake.
3. Fleet registry in the API: enrolled agents, capability labels
   (kernel, bpftrace version, BTF present), and health rollups.
4. Scheduler: a queue that assigns each run to one ready agent,
   honors the per-agent slot, and surfaces queued position to the UI.
5. Web host picker: choose a target before confirming, see per-host
   health, and keep single-host mode as the zero-config default.

## API and UI touchpoints

- Proposed API additions: agent enrollment, heartbeat, and a run
  request that names a target agent. The existing generate, validate,
  sessions, and run-stream shapes are reused, not forked.
- Proposed agent additions: TLS listener and readiness fields that
  feed the registry. Validation, limits, and teardown logic stay put.
- Web: host selector near the run controls, per-host health badges,
  and session rows that record which agent produced them.

## Test strategy

- Unit and contract tests with stub agents over loopback: enrollment,
  scheduler slot accounting, queue ordering, and revocation.
- TLS handshake tests with fixture certificates, including expired
  and wrong-identity rejection.
- Manual privileged runbook on two real hosts; CI stays mock-only
  with no secrets and no routable listeners.

## Non-goals

- Multi-user authentication or per-user authorization.
- Cross-host correlated queries or distributed aggregation.
- Autoscaling, service discovery, or mesh integration.
- Replacing the single-host loopback default.
