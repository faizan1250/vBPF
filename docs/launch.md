# Launch drafts — v0.3.0 (DO NOT POST; drafts only)

Per D-5, launch is gated on R-01, R-02, and P1 results. Post only when the
maintainer says so. Launch gate for this release: the real-agent eval
report `eval/reports/2026-11-10-live-real.md` (live+agent, generated
scripts dry-run compiled and run on a real kernel) must be committed and
linked from the README. Static-only reports never count as launch
evidence and are never quoted as "compiles". Canonical pitch (from
README): "vBPF does for eBPF what Postman did for `curl`."

Facts every draft must keep true: Linux 5.8+ with BTF, bpftrace 20+, root
for the agent only, Node 22+ / Go 1.26+, one probe at a time, single host.
Real-agent eval (`groq/openai/gpt-oss-120b`, kernel
`6.6.87.2-microsoft-standard-WSL2`, bpftrace `v0.20.2`): static validation
26/26, dry-run compile 20/26 first try (23/26 within retries), 4/4
adversarial refused (30/30 refusal-correct), 20/23 validated generated
scripts produced events in 5 s runs. Recipe-only mode works with no API
key; only the prompt script text is sent to the LLM, never probe output.

---

## Show HN: vBPF — Postman for eBPF (plain English to safe bpftrace probes)

Hi HN! I built vBPF: describe what you want to observe in plain English
("which processes are doing the slowest disk writes?") and get a safe,
reviewable bpftrace probe plus a live chart.

It does for eBPF what Postman did for `curl`: the generated script is shown
for confirmation before anything runs, then validated three ways (static
checks, dry-run compile, kernel verifier) and executed with hard time and
output caps. An "Explain this probe" button walks through any script in
plain English.

Honest numbers from the real-agent eval (model `groq/openai/gpt-oss-120b`,
real kernel): 20/26 dry-run compiled first try (23/26 within retries),
4/4 adversarial prompts refused (30/30 refusal-correct), 20/23 validated
generated scripts produced real kernel events in 5 s runs. The two dry-run
targets were missed and are published as-is with a gap analysis.
Recipe-only mode works with no API key. Single Linux host (5.8+, BTF), one
probe at a time, root needed for the agent only.

Repo + demo GIF in the README. Happy to answer hard questions about the
validator and the sandbox.

---

## r/linux

vBPF 0.3.0: type what you want to watch, get a reviewable bpftrace probe
and live charts — Postman-for-`curl`, but for eBPF.

- LLM generation grounded in your kernel's real tracepoint args
  (`bpftrace -vl`), static validation + dry-run + kernel verifier, confirm
  before run, hard time/output limits
- Explain-this-probe panel; run summaries via `GET /api/runs/:id`
- Real-agent eval: dry-run 20/26 first try (23/26 within retries), 4/4
  adversarial refused, 20/23 validated generated scripts produced events
  on a real kernel (WSL2)
- Works with no key in recipe-only mode; probe output never leaves your
  machine

Needs Linux 5.8+ w/ BTF, bpftrace 20+, root for the agent only. One probe
at a time, single host for now. Demo GIF and overhead/platform tables in
the README.

---

## r/devops

Sick of writing one-off bpftrace by hand during incidents? vBPF 0.3.0 turns
"which processes are doing the slowest disk writes?" into a confirmed,
validated probe with live tables/charts — think Postman vs `curl`.

Safety model for prod-adjacent use: every script is shown for confirmation,
re-validated by the agent, dry-run compiled, and time/output-capped; no
`--unsafe`, nothing runs without review. Origin allowlist, wildcard-bind
guard, and secret scanning are in as of this release.

Caveats, stated plainly: single host, one probe at a time, Linux 5.8+/BTF
required. Real-agent eval on `groq/openai/gpt-oss-120b`: dry-run 20/26
first try (23/26 within retries), 4/4 prompt-injection refused, 20/23
validated generated scripts emitted events in 5 s.

---

## r/ebpf

vBPF 0.3.0 — natural-language frontend for bpftrace, with the safety part
taken seriously:

- Prompt → script via ordered LLM chain (Groq default), grounded in
  `bpftrace -vl` arg formats fetched from your own kernel plus 10 tested
  recipes
- Triple validation (static, dry-run, verifier), confirm-before-run,
  process-group kill with stale-child sweep on startup
- Chaos-tested mid-run kills (agent/API/tab/bpftrace) with leftover checks

Eval (live+agent, committed in `eval/reports/`): static 26/26, dry-run
20/26 first try (23/26 within retries), 30/30 refusal-correct,
produced-output 20/23 validated generated scripts (the 3 no-event cases
were low-traffic probes or thresholds, detailed in the report). Would
appreciate eyes on the validator (`api/src/validator*`) and the runner's
teardown path.

---

## X (280 chars each, thread)

1/ vBPF 0.3.0: Postman for eBPF. Type what you want to observe, get a safe
reviewable bpftrace probe + live charts.

2/ Confirm-before-run, triple-validated (static + dry-run + kernel
verifier), time/output capped. No --unsafe, ever.

3/ Real-kernel eval: dry-run 20/26 first try, 4/4 injections refused,
20/23 validated scripts fired real kernel events.

4/ Recipe-only mode needs no API key. Your probe output never leaves your
machine. Demo GIF in the README:

---

## Lobsters

Title: vBPF: plain English to bpftrace probes, with the safety part
taken seriously

Suggested tags: linux, ebpf, observability

First comment: I am the author. vBPF turns "which processes are doing
the slowest disk writes?" into a reviewable bpftrace probe plus a live
chart. The part I would like this audience to kick: the validator. It
is a token-level lexer with a default-deny function allowlist, mirrored
in the API and the agent and pinned identical by 73 shared vectors. The
real-agent eval (model `groq/openai/gpt-oss-120b`, real kernel) is
committed in `eval/reports/2026-11-10-live-real.md`: dry-run 20/26
first try (23/26 within retries), 4/4 adversarial refused, 20/23
validated generated scripts produced kernel events in 5 s runs. The two
dry-run misses are published as-is with a gap analysis. The longer
story, including six bypasses found and fixed (comment-split calls,
extra probe headers, uprobe path abuse, per-token probe cap, published
ports, dropped terminal events), is drafted in `docs/launch-post.md`.

FAQ (short):

- Safety: confirm-before-run, static plus dry-run plus kernel
  verifier, time/output caps, no `--unsafe`, probe output never leaves
  the machine.
- Cost: recipe-only mode needs no key; live mode is one paid chain
  (Groq default) plus an openai preset and a native Anthropic adapter.
  Roughly 68k real tokens for the full 30-case eval.
- Models: Groq default (`gpt-oss-120b` in the report), OpenAI preset,
  native Anthropic adapter, local models over loopback.
- Kernels: Linux 5.8+ with BTF, bpftrace 20+; verified only where a
  run is recorded, everything else is labeled untested
  (`docs/compat.md`).

---

## eBPF community channel

Title: vBPF 0.3.0: natural-language frontend for bpftrace, validator
open for review

Post in the community venue the maintainer uses (Slack or mailing
list) — drafts only, never posted from this diff.

First comment: vBPF generates bpftrace probes from plain English and
validates them three ways (static, dry-run, verifier) with
confirm-before-run. Real-agent eval on `groq/openai/gpt-oss-120b`:
dry-run 20/26 first try (23/26 within retries), 30/30
refusal-correct, 20/23 validated generated scripts emitted events in
5 s. Validator code is `agent/internal/server/` plus `api/src/validator*`
with 73 shared vectors; teardown and runner paths survived
chaos-tested mid-run kills. Happy to take hard questions on the
validator and the runner.

FAQ (short):

- Safety: same four layers as above; single host, one probe at a time,
  root needed for the agent only (capability-scoped compose, no
  `privileged`).
- Cost: recipe library and fixture demo are free and keyless; only
  prompt script text is sent to the LLM.
- Models: Groq default, OpenAI preset, native Anthropic adapter, custom
  base-URL override for local models.
- Kernels: needs BTF and bpftrace 20+; kernel-compat reports from other
  machines are the most wanted contribution.

---

## Show HN / Reddit first-comment FAQ (shared)

Use under any of the drafts above when the same questions come up.
Answers stay inside the committed evidence:

- Is it safe to run? Confirm-before-run, static plus dry-run plus
  kernel verifier, time/output caps, no `--unsafe`. Six past bypasses
  are fixed with regression tests (see `docs/launch-post.md`).
- What does it cost? Nothing without a key (recipes, fixtures, demo).
  Live generation uses your own provider key; the full 30-case eval
  used about 68k real tokens.
- Which models? Groq by default, OpenAI preset, native Anthropic
  adapter, local loopback models via base-URL override.
- Which kernels? Linux 5.8+ with BTF, bpftrace 20+. Only recorded runs
  count as supported; the rest is untested, not broken.

---

## Launch checklist (all DRAFT until the maintainer says go)

- [ ] Demo live: hosted fixture demo loads with no keys, GIF in README
      matches the current UI.
- [ ] Release published: tag pushed, release workflow green, notes are
      the CHANGELOG section for the tag.
- [ ] README metrics real: every number traces to a committed report
      (`eval/reports/2026-11-10-live-real.md`); no static-only figure is
      quoted as "compiles".
- [ ] Issues triaged: open bugs labeled, `good first issue` and
      `kernel-report` queues groomed, stale items closed or milestoned.
- [ ] Response plan for the first 24 hours: maintainer watches
      replies in two windows (morning/evening), answers safety questions
      from the shared FAQ, files kernel reports as issues instead of
      arguing them, and posts nothing new until the first wave is answered.

---

## Metrics to track after launch (goals, not deliverables)

| metric                | how measured                                        | 30-day goal |
| --------------------- | --------------------------------------------------- | ----------- |
| stars                 | repo stars                                          | 100         |
| unique clones         | traffic insights                                    | trend up    |
| kernel-compat reports | committed `compat/*.json` or `kernel-report` issues | 10          |
| external contributors | non-maintainer merged PRs                           | 5           |
| recipes added         | merged recipe PRs                                   | trend up    |
| tagged release        | published tag after launch                          | 1           |
