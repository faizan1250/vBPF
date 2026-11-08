export const MAX_SCRIPT_BYTES = 8 * 1024;
export const MAX_PROBES = 50;

const BLOCKED_CALLS = /\b(system|signal|override|cat)\s*\(/;
const INCLUDE_RE = /^\s*#\s*(include|define)\b/m;
const PROBE_RE =
  /\b(tracepoint|kprobe|kretprobe|uprobe|uretprobe|profile|interval|software):[^\s{;,)]+|\bBEGIN\b|\bEND\b/g;

const ALLOWED_PROVIDERS = new Set([
  "tracepoint",
  "kprobe",
  "kretprobe",
  "uprobe",
  "uretprobe",
  "profile",
  "interval",
  "software",
  "BEGIN",
  "END",
]);

const HIGH_FREQ = new Set([
  "tracepoint:raw_syscalls:sys_enter",
  "tracepoint:raw_syscalls:sys_exit",
]);

export interface StaticResult {
  probes: string[];
  errors: string[];
  warnings: string[];
}

function expandCount(pattern: string, known: Set<string>): number {
  const star = pattern.indexOf("*");
  const prefix = star < 0 ? pattern : pattern.slice(0, star);
  let n = 0;
  for (const k of known) {
    if (k.startsWith(prefix)) n += 1;
  }
  return n;
}

export function staticValidate(
  script: string,
  knownProbes: string[] = [],
): StaticResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (script.trim() === "")
    return { probes: [], errors: ["empty script"], warnings };
  if (script.length > MAX_SCRIPT_BYTES) {
    return { probes: [], errors: ["script exceeds 8 KB"], warnings };
  }
  if (script.includes("--unsafe")) errors.push("--unsafe is forbidden");
  if (BLOCKED_CALLS.test(script)) {
    errors.push("blocked call: system/signal/override/cat are forbidden");
  }
  if (INCLUDE_RE.test(script)) {
    errors.push("blocked syntax: #include/#define are forbidden");
  }
  const probes = script.match(PROBE_RE) ?? [];
  if (probes.length === 0) errors.push("no probes found");
  const known = new Set(knownProbes);
  for (const pr of probes) {
    const colon = pr.indexOf(":");
    const provider = colon < 0 ? pr : pr.slice(0, colon);
    if (!ALLOWED_PROVIDERS.has(provider)) {
      errors.push(`provider not allowed: ${provider}`);
      continue;
    }
    if (provider === "uprobe" || provider === "uretprobe") {
      const rest = pr.slice(provider.length + 1);
      if (!rest.includes("libc") && !rest.startsWith("/")) {
        errors.push(`uprobe must target libc or an absolute path: ${pr}`);
      }
    }
    if (pr.includes("*")) {
      if (
        pr === "*" ||
        pr.endsWith(":*") ||
        pr === "tracepoint:*:*" ||
        pr === "kprobe:*"
      ) {
        errors.push(`wildcard too broad: ${pr}`);
        continue;
      }
      if (known.size > 0) {
        const n = expandCount(pr, known);
        if (n > MAX_PROBES) {
          errors.push(`wildcard expands to too many probes: ${pr}`);
        } else if (n === 0) {
          errors.push(`probe not found: ${pr}`);
        } else {
          warnings.push(
            `Wildcard probe expands to ${n} probes; capped at ${MAX_PROBES}.`,
          );
        }
      }
      continue;
    }
    if (
      known.size > 0 &&
      provider !== "profile" &&
      provider !== "interval" &&
      provider !== "software" &&
      provider !== "BEGIN" &&
      provider !== "END"
    ) {
      if (!known.has(pr)) errors.push(`probe not found: ${pr}`);
    }
  }
  if (/\bprintf\s*\(/.test(script)) {
    const hot = probes.some(
      (p) => HIGH_FREQ.has(p) || p.startsWith("profile:"),
    );
    if (hot) {
      warnings.push("High-frequency probe; output is aggregated in-kernel.");
    } else if (probes.some((p) => p.includes("raw_syscalls"))) {
      warnings.push("High-frequency probe; output is aggregated in-kernel.");
    }
  }
  return { probes, errors, warnings };
}

export function truncateErrors(errors: string[], max = 20): string[] {
  return errors
    .map((e) => e.trim())
    .filter((e) => e !== "")
    .slice(0, max)
    .map((e) => e.slice(0, 500));
}
