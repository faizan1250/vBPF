# Launch drafts — v0.2.0 (DO NOT POST; drafts only)

Per D-5, launch is gated on R-01, R-02, and P1 results. Post only when the
maintainer says so. Canonical pitch (from README): "vBPF does for eBPF what
Postman did for `curl`."

Facts every draft must keep true: Linux 5.8+ with BTF, bpftrace 20+, root
for the agent only, Node 22+ / Go 1.27+, one probe at a time, single host.
Live eval (`groq/openai/gpt-oss-120b`): 26/26 first-try compile, 4/4
adversarial refused, 9/10 recipes produced events in 5 s runs. Recipe-only
mode works with no API key; only the prompt script text is sent to the LLM,
never probe output.

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

Honest numbers from the live eval (model `groq/openai/gpt-oss-120b`):
26/26 prompts compiled first try, 4/4 adversarial prompts refused, 9/10
recipes produced real kernel events in 5 s runs. Recipe-only mode works
with no API key. Single Linux host (5.8+, BTF), one probe at a time, root
needed for the agent only.

Repo + demo GIF in the README. Happy to answer hard questions about the
validator and the sandbox.

---

## r/linux

vBPF 0.2.0: type what you want to watch, get a reviewable bpftrace probe
and live charts — Postman-for-`curl`, but for eBPF.

- LLM generation grounded in your kernel's real tracepoint args
  (`bpftrace -vl`), static validation + dry-run + kernel verifier, confirm
  before run, hard time/output limits
- Explain-this-probe panel; run summaries via `GET /api/runs/:id`
- Live eval: 26/26 first-try compile, 4/4 adversarial refused, 9/10
  recipes produced events on a real kernel (WSL2)
- Works with no key in recipe-only mode; probe output never leaves your
  machine

Needs Linux 5.8+ w/ BTF, bpftrace 20+, root for the agent only. One probe
at a time, single host for now. Demo GIF and overhead/platform tables in
the README.

---

## r/devops

Sick of writing one-off bpftrace by hand during incidents? vBPF 0.2.0 turns
"which processes are doing the slowest disk writes?" into a confirmed,
validated probe with live tables/charts — think Postman vs `curl`.

Safety model for prod-adjacent use: every script is shown for confirmation,
re-validated by the agent, dry-run compiled, and time/output-capped; no
`--unsafe`, nothing runs without review. Origin allowlist, wildcard-bind
guard, and secret scanning are in as of this release.

Caveats, stated plainly: single host, one probe at a time, Linux 5.8+/BTF
required. Live eval on `groq/openai/gpt-oss-120b`: 26/26 compiled first
try, 4/4 prompt-injection refused, 9/10 recipes emitted events in 5 s.

---

## r/ebpf

vBPF 0.2.0 — natural-language frontend for bpftrace, with the safety part
taken seriously:

- Prompt → script via ordered LLM chain (Groq default), grounded in
  `bpftrace -vl` arg formats fetched from your own kernel plus 10 tested
  recipes
- Triple validation (static, dry-run, verifier), confirm-before-run,
  process-group kill with stale-child sweep on startup
- Chaos-tested mid-run kills (agent/API/tab/bpftrace) with leftover checks

Eval (live, committed in `eval/reports/`): 26/26 first-try compile, 30/30
refusal-correct, produced-output measured per recipe (9/10 in-window; the
10th only fires on ≥10 ms block I/O). Would appreciate eyes on the
validator (`api/src/validator*`) and the runner's teardown path.

---

## X (280 chars each, thread)

1/ vBPF 0.2.0: Postman for eBPF. Type what you want to observe, get a safe
reviewable bpftrace probe + live charts.

2/ Confirm-before-run, triple-validated (static + dry-run + kernel
verifier), time/output capped. No --unsafe, ever.

3/ Live eval: 26/26 compiled first try, 4/4 injections refused, 9/10
recipes fired real kernel events.

4/ Recipe-only mode needs no API key. Your probe output never leaves your
machine. Demo GIF in the README:
