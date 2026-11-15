// Retry-feedback shaping (I-11): normalize raw validator / dry-run errors
// before they go back to the model. Only the feedback copy is shaped; the
// stored generation record and eval reports keep the raw errors.

/** Max chars for one shaped error line (I-11: ~300). */
export const SHAPED_ERROR_CAP = 300;

// Terminal control sequences: CSI ... <letter> plus charset switches.
// Intentional: strip ANSI color/banner bytes from compiler stderr.
// eslint-disable-next-line no-control-regex
const ANSI_RE = new RegExp("\u001b\\[[0-9;?]*[A-Za-z]|\u001b[()][0-9A-B]", "g");

// Lines that carry no diagnostic signal: bpftrace banners, attach chatter,
// libbpf/BTF debug dumps, deprecated-flag and generic warnings, AST dumps
// (headers, separators, typed nodes, bare probe echoes, punctuation-only
// caret/context lines). The first actionable line (below) is what the model
// sees. Lines containing ERROR are never noise: the guard in isNoise keeps
// located compiler errors even if they share a prefix with a banner.
const NOISE_RES = [
  /^attach(ed|ing)(\s+\d+)?\s+probe/i,
  /^\[(DEBUG|INFO|TRACE)\]/i,
  /libbpf/i,
  /\bBTF\b/i,
  /^WARNING:/i,
  /^\[WARNING\]/i,
  /^(HINT|NOTE|Log):/i,
  /^entrance/i,
  /^program id/i,
  /^AST\s+(after|before):/i,
  /^bpftrace v?\d/i,
  /^using .*BTF/i,
  /:\d+:\d+(-\d+)?:\s*(WARNING|HINT|NOTE)/i,
  /^---+\s*$/,
  /^===+\s*$/,
  /^___+\s*$/,
  // Punctuation/whitespace only: "---", "=", ".", "~", "^~~", etc.
  /^[^A-Za-z0-9]+$/,
  /^(program|source|block)\b/i,
  /^(map|builtin|call|variable|dereference|field|integer|string|boolean|binop|unop|predicate|statement|expression|assign|tuple|record|type|source|block|probe|program|inline|cast|if|else|for|while|loop|return)\s*:/i,
  /^(tracepoint|kprobe|kretprobe|uprobe|uretprobe|profile|interval|software|BEGIN|END)(:[A-Za-z0-9_*/?.[\]-]+)*\s*$/,
  /^(running|listening)\b/i,
];

function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, "");
}

function isNoise(line: string): boolean {
  const t = line.trim();
  if (t === "") return true;
  // A located compiler error is always signal, never banner noise.
  if (/ERROR/i.test(t)) return false;
  return NOISE_RES.some((re) => re.test(t));
}

// Actionable signal for retry feedback: compiler errors, validator-style
// rejections (including every hint-table trigger), and dry-run
// infrastructure failures. Deliberately excludes AST vocabulary ("type",
// "map", "call") so AST dumps never count as signal.
const ACTIONABLE_RE =
  /error|not found|unknown|invalid|fail|missing|blocked|forbidden|not allowed|too many|exceed|unsupported|not supported|undeclared|undefined|cannot|can'?t|couldn'?t|syntax|parse|mismatch|denied|refus|dry-run|no such|bad|wrong/i;

// First actionable line: prefer a located compiler error
// (`path:line:col: ERROR`, via stdin or the validator's temp file), else the
// first line with actionable signal. Returns "" when only banners, BTF
// debug, and AST dumps remain (honest no-signal beats a misleading "---" or
// AST fragment in the retry prompt).
function firstErrorLine(lines: string[]): string {
  const kept = lines.map((l) => l.trim()).filter((l) => !isNoise(l));
  if (kept.length === 0) return "";
  const located = kept.find((l) => /:\d+:\d+(-\d+)?:\s*ERROR/i.test(l));
  if (located !== undefined) return located;
  const mentioned = kept.find((l) => ACTIONABLE_RE.test(l));
  return mentioned ?? "";
}

// One hint line per failure class (I-11 rule table). Matched against the
// shaped error only, so probe text cannot steer the hint.
const HINT_RULES: Array<[RegExp, string]> = [
  [
    /args?->\w+|unknown.*\barg\b|has no (field|member)|invalid.*field/i,
    "Hint: tracepoint arg names differ per tracepoint; use args->field exactly as listed in ==ARG_FORMATS==, never guess.",
  ],
  [
    /undeclared|undefined|must be (declared|assigned)|missing `@`|unknown variable/i,
    "Hint: scratch variables and maps need an @ prefix and must be assigned before use.",
  ],
  [
    /string.*int|int.*string|incompatible|type mismatch|must be an integer|integral/i,
    "Hint: map keys and values have fixed types; compare strings with str() and keep arithmetic on integers.",
  ],
  [
    /probe not found|unknown probe|no such probe/i,
    "Hint: use only the probes listed under ==PROBES==, the recipe probes, or allowed uprobe:libc:<symbol>; never invent probe names.",
  ],
  [
    /too many probes|expands to too many/i,
    "Hint: narrow the wildcard or pick one tracepoint; at most 50 probes attach per script.",
  ],
  [
    /blocked call|unknown function call/i,
    "Hint: only aggregation and output helpers are allowed (count, hist, printf, str, ntop, delete, clear); system/signal/override/cat are forbidden.",
  ],
  [
    /invalid character|unterminated (string|char)|single quotes/i,
    'Hint: bpftrace strings and character comparisons use double quotes ("W"), never single quotes.',
  ],
];

export function hintForError(shaped: string): string | null {
  for (const [re, hint] of HINT_RULES) {
    if (re.test(shaped)) return hint;
  }
  return null;
}

/**
 * Shape one raw error for retry feedback: strip ANSI, drop banner/noise
 * lines, keep the first actionable line capped at ~300 chars.
 */
export function shapeError(raw: string): string {
  const lines = stripAnsi(raw).split("\n");
  const first = firstErrorLine(lines);
  const chars = Array.from(first.trim());
  return chars.length <= SHAPED_ERROR_CAP
    ? first.trim()
    : chars.slice(0, SHAPED_ERROR_CAP).join("");
}

/**
 * Shape the feedback copy of a retry's errors: join the raw lines (one
 * logical dry-run error often spans elements), strip ANSI, drop
 * banner/noise, keep the first actionable line capped at ~300 chars, plus
 * one hint line. Returns [] for empty input.
 */
export function shapeFeedbackErrors(errors: string[]): string[] {
  const first = shapeError(errors.join("\n"));
  if (first === "") return [];
  const hint = hintForError(first);
  return hint === null ? [first] : [`${first}\n${hint}`];
}
