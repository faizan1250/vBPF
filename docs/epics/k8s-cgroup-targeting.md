# Epic: Kubernetes pod-to-cgroup targeting

Tracking: https://github.com/faizan1250/vBPF/issues/147

## Problem

Probes see the whole host. On a Kubernetes node there is no way to
say "trace only this pod": users must hand-translate pod names to
cgroup paths and hand-edit filters, which is error-prone and breaks
as pods churn.

## Constraints

- Resolution assumes cgroup v2 layout; hosts without it keep the
  current whole-host behavior with a clear notice.
- The agent gains read-only visibility into pod-to-cgroup mapping,
  never write access to the cluster or the workload.
- The per-agent one-run cap is unchanged; pod scoping filters
  events, it does not multiplex runs.
- Loopback default stays: the agent runs on the node and the API
  reaches it the same way it does today.
- BTF and kernel requirements are unchanged; missing tracepoints
  still report not-found with a suggestion.

## Phased plan

1. Resolver: map pod name and namespace to cgroup IDs from node
   state, with caching that tolerates pod churn during a run.
2. Filter injection: generated scripts gain a cgroup scoping
   predicate from reviewed patterns; hand-written scripts can use
   the same helper.
3. Validation: reject stale or ambiguous pod references before
   anything compiles, and warn when a pod restarts mid-run.
4. Web pod picker: namespace and pod fields with live validation,
   reusing the existing confirm-before-run gate.
5. Recipe notes: mark which recipes are pod-scopeable and what
   each one shows under churn.

## API and UI touchpoints

- Proposed API additions: pod resolution preview and scoped run
  creation that carries the resolved cgroup identity. Generate
  responses record the scope used.
- Proposed agent additions: cgroup-aware filter checks and
  mid-run restart warnings on the event stream.
- Web: pod and namespace inputs in the prompt panel, scope badge
  in the confirm dialog, and history entries that keep the scope.

## Test strategy

- Unit tests for the resolver against fixture node state,
  including churn, ambiguous names, and missing pods.
- Contract tests for scoped run creation and stored scope.
- Manual runs on a throwaway cluster; CI stays mock-only with
  fixture cgroup layouts.

## Non-goals

- Shipping a DaemonSet operator or Helm chart.
- Multi-cluster or cross-node correlated tracing.
- Network policy or admission enforcement.
- Replacing host-level tracing; whole-host mode stays.
