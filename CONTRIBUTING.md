# Contributing to vBPF

Contributions are welcome, especially **new recipes** and **kernel compatibility reports**.
Use the issue templates (`bug`, `recipe`, `kernel`) so reports arrive with the right context.

1. Open an issue to discuss larger changes.
2. Fork, create a branch (`feat/<area>-<name>`), and make focused commits using Conventional Commits.
3. Run `make lint && make test` before opening a pull request.
4. For a new recipe, add `recipes/<id>.bt` and `recipes/<id>.yaml`, a captured fixture in `fixtures/`, and a test; include the kernel version you tested on.

Security vulnerabilities: do not open a public issue. Use a GitHub private
vulnerability report or contact the maintainer directly.

License: MIT (see `LICENSE`). By contributing, you agree your changes carry the same license.
