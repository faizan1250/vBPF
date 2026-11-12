# Contributing to vBPF

Contributions are welcome, especially **new recipes** and **kernel compatibility reports**.
Use the issue templates (`bug`, `recipe`, `kernel`) so reports arrive with the right context.

## Your first contribution

The fastest way in is a recipe, and it needs no prior eBPF experience:

1. Pick a gap: open recipe proposals carry the `recipe` label, and small,
   well-scoped ones also carry `good first issue`.
2. Scaffold it: `scripts/new-recipe.sh <id>`, then follow
   [docs/writing-recipes.md](docs/writing-recipes.md). One page covers the
   probe rules, the checks, and fixture capture.
3. Verify: `make recipe-check ID=<id>` must pass. If you verified on a real
   kernel, run `scripts/compat-report.sh` and paste it into a kernel report
   issue so the compatibility matrix can include your result.
4. Open a pull request: fork, create a branch (`feat/<area>-<name>`), and
   make focused commits using Conventional Commits. Run `make lint && make test`
   before opening the pull request.

## Labels

Maintainers triage with this vocabulary (labels are created by the
maintainer; suggest new ones in an issue rather than adding ad-hoc tags):

- `good first issue`: small, well-scoped, needs no prior eBPF experience.
- `recipe`: a new or improved library recipe.
- `kernel-report`: a compatibility report from a real kernel.
- `help wanted`: the maintainer welcomes a pull request for this.

General contribution steps:

1. Open an issue to discuss larger changes.
2. Fork, create a branch (`feat/<area>-<name>`), and make focused commits using Conventional Commits.
3. Run `make lint && make test` before opening a pull request.
4. For a new recipe, add `recipes/<id>.bt` and `recipes/<id>.yaml`, a captured fixture in `fixtures/`, and a test; include the kernel version you tested on.

Security vulnerabilities: do not open a public issue. Use a GitHub private
vulnerability report or contact the maintainer directly.

License: MIT (see `LICENSE`). By contributing, you agree your changes carry the same license.
