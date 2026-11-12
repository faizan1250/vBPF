# Writing recipes

A recipe is a hand-written bpftrace probe plus metadata: `recipes/<id>.bt`,
`recipes/<id>.yaml`, and a captured `fixtures/<id>.ndjson`. Newcomers can
ship one in under an hour by following this page.

## Scaffold

Run `scripts/new-recipe.sh <id>` (lowercase letters, digits, hyphens). It
copies `recipes/_template.bt` and `recipes/_template.yaml` and substitutes
the id. Template files start with an underscore and are scaffolding, never
recipes: validators skip them.

## Metadata

Every `recipes/<id>.yaml` needs these fields
(`scripts/validate-recipes.sh` enforces the schema):

| Field                  | Meaning                                                                                                                                                                                                       |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`                   | Must equal the filename stem.                                                                                                                                                                                 |
| `title`, `description` | One line plus one or two sentences: the question the probe answers.                                                                                                                                           |
| `tags`                 | Search terms, e.g. `network`, `security`, `latency`.                                                                                                                                                          |
| `view`                 | One of `table`, `bar`, `histogram`, `timeseries`, `events`. Streaming `printf` output reads as `events`; `END`-block map dumps as `table`/`bar`; per-second `interval` dumps as `timeseries`.                 |
| `duration_default`     | Suggested run length, 1 to 60 seconds.                                                                                                                                                                        |
| `min_kernel`           | Oldest kernel the probes need, e.g. `"5.8"`.                                                                                                                                                                  |
| `requires`             | Probe headers exactly as written in the `.bt`, e.g. `tracepoint:sched:sched_process_exec`. `scripts/collect-compat.sh` checks each one with `bpftrace -l`, so a typo shows up as `unavailable` in the matrix. |
| `params`               | Recipe parameters; `[]` when there are none.                                                                                                                                                                  |

## Probe rules

- Prefer tracepoints over kprobes: they are the stable interface and they
  keep working across kernel upgrades. Uprobes are limited to libc symbols.
- The agent validator is default-deny on function calls. The allowlist is
  `printf`, `print`, `count`, `sum`, `avg`, `min`, `max`, `stats`, `hist`,
  `lhist`, `delete`, `clear`, `zero`, `str`, `strncmp`, `strlen`, `buf`,
  `ntop`, `kstack`, `ustack`, `ksym`, `usym`, `time`, `join`, `exit`,
  `cgroup_path`, `cgroupid`. `system`, `signal`, `override`, and `cat` are
  rejected, as are preprocessor lines and `config` blocks.
- Avoid `printf` on hot paths (every-syscall or every-scheduler-event
  probes): aggregate into maps or histograms and dump in an `END` block,
  or sample on an `interval` like `recipes/tcp-retransmits.bt`.
- Entry/exit pairing: some tracepoints only carry arguments on entry
  (`sys_enter_openat` has the path, `sys_exit_openat` has only the return
  code). Save what you need in a map keyed by `tid` at entry, print and
  `delete` it at exit; see `recipes/openat-errors.bt`. Always delete on
  both outcomes or the map grows for the whole run.
- Watch the modern variants: current glibc opens files via `openat2`, so an
  `openat`-only recipe misses most opens. When a syscall has a newer twin,
  attach to both (`recipes/openat-errors.bt` covers `openat` and `openat2`).

## Check

`make recipe-check ID=<id>` runs the per-recipe gate: schema, static rules,
fixture presence, and a `bpftrace -d` dry-run when bpftrace is available.
`make recipes-check` (part of `make lint`, run by CI on every push and pull
request) validates all recipes at once.

## Fixtures

`fixtures/<id>.ndjson` holds real captured output so the parser, API, and
UI can be developed without root (`scripts/fake-bpftrace.sh` replays it).
Capture with the sentinel workload in `scripts/produced-output.sh` (add a
case for the new recipe) or by hand:

1. Start the workload that generates events.
2. Run `bin/agent run recipes/<id>.bt --duration 10` as root.
3. Convert the data lines to fixture shape: keep `printf`/`map`/`hist`
   events as `{"type": ..., "data": ...}` lines, drop the run envelope.
4. Trim to a handful of representative lines and scrub paths, usernames,
   and other machine-specific values before committing.

## Compatibility report

After verifying on a kernel, run `scripts/compat-report.sh` and paste the
output into a kernel report issue ([kernel.yml](../.github/ISSUE_TEMPLATE/kernel.yml)).
It prints the distro, kernel, BTF state, bpftrace version, and per-recipe
probe availability. Maintainers fold confirmed reports into `compat/*.json`
(rendered to [compat.md](compat.md) by `scripts/render-compat.mjs`).

## Submit

Open a pull request with the `.bt`, `.yaml`, and fixture. Tag it with the
`recipe` label; first-time contributors should also add `good first issue`
when the recipe fills a gap from the suggested list. Unsure about a probe?
Open a [recipe proposal](../.github/ISSUE_TEMPLATE/recipe.yml) first.
The contribution steps and label vocabulary live in
[CONTRIBUTING.md](../CONTRIBUTING.md).
