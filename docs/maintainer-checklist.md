# Maintainer checklist (one-time steps)

Maintainer-only. The agent must never run these commands. They change
repository settings, push tags, and publish releases — all outside what any
agent is allowed to do.

## 1. Repository metadata

Run once (values as agreed; edit the description freely):

```bash
gh repo edit faizan1250/vBPF --description "Ask in plain English, review the exact bpftrace probe, run it behind a safety gate, watch live charts" --add-topic ebpf --add-topic bpftrace --add-topic llm --add-topic observability --add-topic sre --add-topic linux --add-topic tracing
```

## 2. Pages and private vulnerability reporting

In the repository Settings on the web UI (no CLI equivalent):

- Enable GitHub Pages: Settings, Pages, Source: GitHub Actions.
- Enable private vulnerability reporting: Settings, Code security.

## 3. Labels

```bash
gh label create "good first issue"
gh label create "recipe"
gh label create "kernel-report"
gh label create "help wanted"
```

## 4. Branch protection and alerts

In the repository Settings on the web UI:

- Turn on branch protection for `main` (require CI and one review).
- Enable Dependabot alerts.

## 5. Tag and release (when ready)

```bash
git push origin main <version-tag>
```

Then let the release workflow run, review the draft release, and publish it.

## 6. Launch posts

Post launch material from `launch.md` only when the demo, the release, and
the real eval numbers are all live.
