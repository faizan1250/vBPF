# Epic: flame graphs and off-CPU analysis

Tracking: https://github.com/faizan1250/vBPF/issues/149

## Problem

Current views show counts, events, histograms, and time series, but
never where time goes. There is no stack sampling, no flame graph,
and no off-CPU view of blocking behavior, so latency questions end
at "which process" instead of "which code path".

## Constraints

- Stack capture has real overhead: sampling rates stay conservative
  and every recipe documents its measured cost like the existing
  overhead table.
- Symbolization depends on the target: kernel stacks need kallsyms
  access, user stacks need frame pointers or debug info where
  available; missing symbols degrade gracefully to addresses.
- The per-agent one-run cap covers profiling runs; durations keep
  their hard maximum.
- Loopback default, bearer-token gate, and confirm-before-run are
  unchanged; profiles are just another run kind.
- BTF remains required, and missing tracepoints report not-found
  with a suggestion as today.

## Phased plan

1. Sampling recipes: interval-based kernel and user stack capture
   that emits folded stacks through the existing event path.
2. Folded-stack parsing: extend the event parser with a stack
   output kind, capped like every other kind.
3. Flame-graph view: render folded stacks in the web UI with zoom,
   search, and frame filtering. Start from a vendored library
   only if its license and size budget fit; otherwise hand-roll.
4. Off-CPU analysis: scheduler tracepoints for blocking time by
   task and stack, with recipes for common wait causes.
5. Guidance: docs on reading flames, sampling bias, and when
   off-CPU beats on-CPU profiling.

## API and UI touchpoints

- Proposed API additions: a flame chart type in generation output
  and run summaries that carry sample and drop counts.
- Proposed agent additions: none structural; sampling uses the
  current run, validate, and stream paths.
- Web: a new flame view component with zoom and search, plus
  recipe cards and prompt examples for profiling questions.

## Test strategy

- Parser unit tests on fixture folded stacks, including deep,
  truncated, and unsymbolized frames.
- Fixture-driven UI tests for zoom, search, and drop badges.
- Real-kernel sampling runs with overhead measured per recipe;
  CI stays mock-only with captured fixtures.

## Non-goals

- Continuous or always-on profiling.
- Cross-host differential flame graphs.
- In-kernel aggregation of full stacks beyond the map caps.
- Automatic root-cause narratives; the UI shows data, not verdicts.
