# FAQ

Short answers to the questions every visitor asks. Longer truth lives in the
linked README sections.

## Is it safe to run?

Safer than pasting generated scripts into a root shell, but not risk-free:
you are still tracing a kernel. Every probe passes static validation, a
dry-run compile, and the kernel verifier, is re-validated independently by
the privileged agent, runs under hard time and output limits, and — most
importantly — nothing runs until you review the exact script and confirm.
Read the full model in
[`README.md`](../README.md#safety-model) (safety model) and
[`README.md`](../README.md#limitations) (limitations).

Run it on a development machine, a VM, or a host where you are comfortable
granting kernel-level tracing. Never expose the agent or API beyond loopback
without adding your own network controls.

## What leaves my machine?

Only what you opt into. In recipe-only mode nothing is sent anywhere. With
AI generation enabled, the API sends your prompt, selected recipe text,
candidate probe names with tracepoint argument formats, and compiler error
messages to the configured LLM provider. The **Explain this probe** button
sends only the script text. Probe output (process names, file paths, command
lines) is never sent to the LLM. Details:
[`README.md`](../README.md#privacy-and-security).

## Does it work without an API key?

Yes. Recipe-only mode runs the ten built-in recipes with no key and no
network calls: open the UI, pick a recipe, confirm, watch. Generation from
plain English needs a provider key, or a local model reachable over
loopback. See [`README.md`](../README.md#built-in-recipes).

## Which kernels?

Linux 5.8+ with BTF (`/sys/kernel/btf/vmlinux` must exist), plus a recent
bpftrace. Verified only on the kernels in the support matrix; anything else
reports `PROBE_NOT_FOUND` with a suggestion instead of failing silently. See
[`README.md`](../README.md#supported-platforms) and
[`README.md`](../README.md#requirements).

## Why not just ask a chatbot for a bpftrace script?

A chatbot gives you text; you take it on faith and run it as root. vBPF
grounds generation in your kernel's real probe catalog, validates the script
three ways, shows it to you for confirmation, re-validates it in the
privileged agent, caps its runtime and output, and renders the results as
live charts. The written-up comparison is in
[`README.md`](../README.md#how-is-it-different), and measured generation
quality (including misses, published as-is) is in
[`README.md`](../README.md#evaluation).
