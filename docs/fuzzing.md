# Fuzzing and the differential oracle (I-05)

Three layers, all committed, all cheap to run:

| Layer               | Where                                                                                      | What it checks                                                                                                                                           |
| ------------------- | ------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Go native fuzzing   | `agent/internal/server/fuzz_validate_test.go`, `agent/internal/parser/fuzz_parser_test.go` | `go test -fuzz` targets for `StaticValidate`, the lexer/comment stripper, the uprobe target parser, the wildcard grammar, and the bpftrace output parser |
| TS property tests   | `api/src/validator-fuzz.test.ts`                                                           | Same invariants as the Go targets via a hand-written deterministic mutator (no new dependency)                                                           |
| Differential oracle | `agent/internal/server/differential.go` + `differential_integration_test.go`               | `bpftrace --dry-run` verdict vs validator verdict on the corpus; fails only on unsafe-accepted                                                           |

## Invariants (both languages)

Every generated input must satisfy all four; any violation is a bug:

1. **No panic, no throw.** The validator/parser never crashes on any input.
2. **Bounded runtime.** Each input completes within a time bound (Go: 2 s
   per input; TS: 1 s per case) — fuzzing must not find a hang.
3. **Denied calls always rejected.** Any script whose calls (outside
   comments/strings) include `system`, `signal`, `override`, or `cat` is
   rejected, with `BLOCKED_CALL` when the script is within the size cap.
4. **Capped messages.** No error or warning exceeds
   `MAX_VALIDATOR_ERROR_LEN` (500 chars) in either implementation, so
   fuzz-generated probe names cannot echo unbounded raw input back to
   callers. Truncation keeps the message prefix the taxonomy matches on.

Additionally: Go asserts `StaticValidate` determinism (same input, same
result), lexer idempotence (re-lexing the cleaned source surfaces no
comments or preprocessor errors), and `Stream` accounting exactness (one
emitted event per consumed/dropped line, contiguous sequence numbers).

## Running

```bash
make fuzz                      # short pass per target for CI (FUZZ_TIME=30s)
make fuzz FUZZ_TIME=5m         # longer manual run
make test-differential         # bpftrace oracle (Linux + bpftrace; skips elsewhere)
```

TS property tests run inside the normal suite (`make test`, ~1 s).

## Seed corpora

Committed under `agent/internal/server/testdata/fuzz/` and
`agent/internal/parser/testdata/fuzz/`, generated from recipes (`*.bt`),
the shared validator vectors, committed eval scripts
(`eval/reports/2026-11-10-live-real-scripts.ndjson`), and parser fixtures.
Regenerate after adding recipes or vectors:

```bash
cd agent && go run ../scripts/gen-fuzz-corpus.go
```

Failing inputs found by the fuzzer land in `testdata/fuzz/<Target>/` next
to the seeds. Keep them (or fix the bug and keep the regression test) —
never delete them silently.

## Oracle semantics

`parseDryRunVerdict` classifies dry-run stderr with version-tolerant
substring matching (`unsafe`, `not allowed`, `not permitted`,
`forbidden`, `unknown function`, `syntax error`, …). The integration test
requires one property: **no script bpftrace flags as unsafe is accepted by
the validator**. Validator-stricter disagreements (validator rejects what
dry-run accepts) are logged, not failures — the validator is intentionally
stricter than the compiler. `differential_unit_test.go` pins the matcher
against several version-variant phrasings without needing bpftrace.

Status: the oracle unit tests run in CI; the live
`TestDifferentialOracle` skips without Linux + bpftrace and is exercised on
the maintainer's WSL via `make test-differential`.

## Decisions

- Hand-written mutators on both sides instead of a new fuzz/property
  dependency (no `fast-check`, no new Go dependency); the corpus does the
  heavy lifting, the mutator adds edge pressure.
- One shared message cap (500 chars, matching the existing
  `truncateErrors` feedback path) enforced in both validators, not just in
  API feedback formatting.
- Oracle fails only on unsafe-accepted; strictness differences are logs.
  Rationale: the validator deliberately rejects more than bpftrace does.
- CI runs a short fuzz pass (`fuzz-short` job, 30 s per target); long
  soaks are manual.

## Findings

- `expandCount` panicked (`slice bounds out of range`) on star-less input
  because it sliced at `IndexByte('*') == -1`. Unreachable through
  `StaticValidate` (the shape check runs first) but a latent crash for any
  direct caller. Fixed to return 0; pinned by
  `TestExpandCountStarlessReturnsZero` and kept as a fuzz seed shape.
