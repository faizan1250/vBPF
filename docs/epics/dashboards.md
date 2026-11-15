# Epic: saved dashboards and shareable run reports

Tracking: https://github.com/faizan1250/vBPF/issues/148

## Problem

History is short and per-session: useful views cannot be kept,
re-run on demand, or shared with a teammate. Debugging regressions
means rebuilding the same prompts and chart setups from scratch.

## Constraints

- Storage stays in SQLite with capped per-run retention; saved
  views reference prompts and chart types, never unbounded event
  archives.
- Exports remain secret-free by construction: prompts, scripts,
  and summaries only, following the existing export assertions.
- The single-token gate is unchanged; there are no per-user
  permissions in this epic.
- Loopback default and the one-run cap are untouched; dashboards
  re-run probes sequentially through the normal confirm gate.
- Existing session list, detail, and export shapes stay
  compatible; dashboards build on them.

## Phased plan

1. Saved views: name a prompt plus chart type, list them, rename
   and delete, all backed by a small new table.
2. Dashboard layout: arrange saved views in a grid, re-run each
   through the normal confirm flow, and persist the layout.
3. Shareable reports: single-file export of a dashboard or session
   with the same secret-free guarantees as session export, plus a
   static render that needs no backend.
4. Freshness: per-card run state, last-run timestamps, and stale
   markers when recipes or the kernel change underneath.

## API and UI touchpoints

- Proposed API additions: saved-view and dashboard stores with
  list, detail, and export routes mirroring the sessions pattern.
  Unknown ids return not-found; exports set an attachment
  disposition.
- Web: a dashboards page beside history, card actions for re-run
  and export, and confirm dialogs that behave exactly like the
  single-run flow.
- Export format gains a dashboard variant; per-card payloads reuse
  the session export shape.

## Test strategy

- Black-box API tests for the new stores: ordering, detail,
  export content, and id validation.
- Secret-free export assertions extended to dashboard payloads.
- Web tests for layout persistence, re-run wiring, and the
  offline local fallback.

## Non-goals

- A metrics or time-series retention system.
- Alerting, thresholds, or scheduled execution.
- Multi-user sharing, access control, or comments.
- Real-time collaboration on dashboards.
