# DRAFT — DO NOT POST: Letting an LLM write root-level kernel code (safely)

> Status: draft for maintainer review. Post only when the launch gate in
> `docs/launch.md` is met. Every number below comes from the committed
> real-agent report `eval/reports/2026-11-10-live-real.md` (live+agent,
> model `groq/openai/gpt-oss-120b`, kernel
> `6.6.87.2-microsoft-standard-WSL2`, bpftrace `v0.20.2`) unless a
> different committed report is named. Static-only reports are never
> quoted as "compiles".

## The problem

vBPF takes a plain-English observability question ("which processes are
doing the slowest disk writes?") and asks an LLM to produce a bpftrace
probe for it. That probe runs as root against the kernel. The model is
therefore writing root-level kernel code on every request, and models
do what models do: they invent probe names, reach for dangerous calls,
and follow instructions hidden in untrusted text. The product question
was never "can the LLM write bpftrace" — it was "what stands between a
bad generation and the kernel".

## The layered design

No single layer is trusted. A script reaches the kernel only after all
of these agree:

1. **Human confirmation.** The generated script is shown verbatim and
   nothing runs until the user confirms. Recipe-only mode works with no
   API key at all.
2. **Static validation, twice.** The API and the agent share one
   token-level lexer and one default-deny function allowlist, pinned
   identical by 73 shared parity vectors (`packages/schemas/validator-vectors.json`).
   The agent's verdict is authoritative; the API never executes on a
   local veto alone.
3. **Dry-run compile** (`bpftrace -d`) against the real kernel before
   anything attaches.
4. **The kernel verifier itself**, plus hard time and output caps and a
   process-group kill with a stale-child sweep on teardown.
5. **Containment around everything**: loopback-only agent bind,
   fail-closed catalog readiness, scrubbed child environments, and a
   capability-based deployment instead of a privileged container.

Each layer exists because a previous one was bypassed. That is the
rest of this article.

## Real bypasses found and fixed

Every item below was a genuine hole, reproduced before the fix, with a
regression test keeping it closed. Short hashes are commits in this
repo; PR numbers are its pull requests.

### 1. Comment-wrapped blocked calls

The first validator matched blocked calls with a regex over the raw
script text. `system/*(*/(` — a call split by a block comment — sailed
through, because the regex never saw the call the compiler would see.
The fix lexes first and validates the token stream: comments and string
contents are opaque, line continuations rejoin identifiers, and any `#`
outside a string or comment is a preprocessor rejection.
([PR #74](https://github.com/faizan1250/vBPF/pull/74): `0b318c9`,
`0512b5e`, `7a06043`)

### 2. Extra probe headers skipping checks

The validator inspected only the first probe header. A script with two
headers — a benign one first, a malicious one second — validated
against the benign header and executed the malicious one. The fix
parses and allowlists _every_ top-level probe header, rejects unlisted
providers and colon-less targets, and classifies errors by prefix
before any dry-run substring check.
([PR #75](https://github.com/faizan1250/vBPF/pull/75): `930672f`,
`f9ac10d`, `8cbb5b4`, `11b07d1`)

### 3. Uprobe path and alias abuse

Uprobes were the weakest surface: arbitrary library paths, symlink
escapes outside the intended tree, and the bare `libc` alias resolving
to whatever the loader found. The fix restricts uprobes to `"libc"` or
canonical `/lib*` and `/usr/lib*` `libc.so*` paths with plain-identifier
symbols, skips the global `bpftrace -l` catalog lookup (which never
enumerates uprobes), and verifies each target on the host filesystem —
symlink containment, regular file, root-owned, no group/world-writable
bit — plus a bounded `bpftrace -l 'uprobe:<target>:<symbol>'` existence
check. A follow-up review closed the Windows ownership bypass (fail
closed into a denial of service) and preserved the parsed provider so
`uretprobe:` symbols query as `uretprobe:`, not `uprobe:`.
([PR #76](https://github.com/faizan1250/vBPF/pull/76): `c5bcabc`,
`6d09404`, `225a542`; [PR #93](https://github.com/faizan1250/vBPF/pull/93):
`b87a24c`)

### 4. Per-token vs script-wide probe cap

Wildcard probes (`tracepoint:syscalls:*`) expand to many real probes,
and the first cap counted tokens, not expansions: a short script could
attach an unbounded number of probes. The fix counts every literal and
synthetic probe plus expanded wildcard counts against one script-wide
limit (50), allows only a single trailing `*` with a minimum 3-character
prefix, and reports the expansion (`"expands to N probes"`) and the
count to the web UI.
([PR #76](https://github.com/faizan1250/vBPF/pull/76): `c5bcabc`;
surfaced in `940fbbf`, `0c58184`)

### 5. Published ports in front of a privileged agent

The compose file published the web port on all interfaces and the API
accepted Host-gated traffic too loosely — a privileged agent reachable
from beyond loopback. The fix binds the published port to `127.0.0.1`,
forwards the raw host header through nginx, and enforces Host, Origin,
and Fetch-Site gates before CORS handling.
([PR #73](https://github.com/faizan1250/vBPF/pull/73): `82b7f5e`,
`7282ed5`, `463a236`, `0ec51d5`)

### 6. Dropped terminal events

Two variants of one failure mode: the runner's rate limiter could shed
the terminal `summary` event under burst load, and a run whose browser
tab closed mid-stream was never finalized — completion existed only
while someone watched. The fix takes control events (status, summary,
lost) out of the rate window entirely, synthesizes a `no_summary`
failure instead of silently succeeding, and finalizes every run from a
server-owned monitor with deadline and restart reconciliation, so
headless runs complete the same way watched ones do.
([PR #83](https://github.com/faizan1250/vBPF/pull/83): `37b653f`;
[PR #97](https://github.com/faizan1250/vBPF/pull/97): `ee7c417`;
[PR #98](https://github.com/faizan1250/vBPF/pull/98): `8457a84`)

## The eval honesty story

The numbers above are the _third_ generation of eval evidence, and the
first two were misleading in instructive ways:

- **Mock-only** (`eval/reports/2026-11-09.md`): 26/26 "compiled" first
  try — but "compile" meant the static validator only. Nothing was ever
  compiled or executed. Kept for history, never quoted.
- **Live model, stubbed agent** (`eval/reports/2026-11-09-live.md`):
  26/26 first-try again, still static-only, explicitly header-noted as
  superseded. The two dry-run targets that later failed were invisible
  here by construction.
- **Live model, real agent**
  (`eval/reports/2026-11-10-live-real.md`): every generated script
  dry-run compiled and executed for 5 seconds on a real kernel. This is
  the only report quoted as compile or execution evidence, and it is
  where the two misses finally showed up.

What changed between the pretty numbers and the honest ones: the real
agent catalog (built from `bpftrace -l`, which never enumerates uprobes)
rejected every uprobe script at dry run — a catalog gap fixed later in
PR #76 — dry-run error output was too noisy for the retry loop to
self-correct, and the model invents probe names with about one case of
run-to-run swing. Two of three prompt-tuning rounds were spent; the
remaining misses are published as-is in the report with a gap analysis,
not tuned away.

## Results

From `eval/reports/2026-11-10-live-real.md` (30 cases: 26 generatable,
4 adversarial; single full run, so spread is observed across tuning
rounds, not a standard deviation):

| metric                                                 | value             |
| ------------------------------------------------------ | ----------------- |
| passes static validation (first try / within retries)  | 26/26, 26/26      |
| dry-run compile pass (first try)                       | 20/26             |
| dry-run compile pass (within retries)                  | 23/26             |
| produced kernel events in 5 s runs (generated scripts) | 20/23             |
| correct refusals (adversarial 4/4)                     | 30/30             |
| view-match / probe-match (real catalog)                | 22/23 / 23/23     |
| latency avg / p50                                      | 3965 ms / 3387 ms |
| tokens (real usage reported by provider)               | 68028             |

Variance, stated plainly: this is one full run (n=1). Across the tuning
rounds first-try dry-run sat at 20/26 in both baseline and final runs
(target 80% missed), within-retries moved 21/26 to 23/26 (target 95%
missed), produced-output held 19–20/21–23 (target 80% passed), and
identical prompts across identical runs swung by about one case — model
probe-name invention, not validator flakiness. Latency skews long-tail
(avg above p50) because retried cases run up to 3 attempts. The 3
dry-run misses (`direct-03`, `direct-06`, `paraphrased-03`: uprobe
catalog gap plus one invented `tracepoint:oom:killer`) and the 3
no-event runs (`direct-10`, `paraphrased-08`, `param-01`: low-traffic
probes in a quiet 5 s window) are listed by id in the report.

## What is still open

- **One host, one probe.** Single-host tracing, one probe at a time.
  Server-side sessions and export, Kubernetes/cgroup targeting, and
  multi-host agents are roadmap, not code.
- **The agent still runs privileged-adjacent.** Capabilities
  (`BPF`, `PERFMON`, `SYS_RESOURCE`) instead of `privileged`, but a
  capability-scoped agent plus uprobes that can read user-space memory
  of any process is a residual risk, stated not softened. The LLM
  provider sees prompt text (never probe output); kernel verifier bugs
  are out of scope for this project to fix.
- **Model variance is the steering wheel now.** Every bypass above was
  deterministic and is pinned by tests. What moves the numbers
  run-to-run is the model inventing probe names — the current work is
  prompt grounding and error feedback, not more validator rules.
- **Kernel coverage is thin.** Verified only where a run is recorded;
  everything else is labeled untested. Kernel-compat reports from other
  machines are the most valuable contribution right now.
