export const MAX_SCRIPT_BYTES = 8 * 1024;
export const MAX_PROBES = 50;

// Bounds every static-validation error/warning so fuzz-generated (or
// adversarial) probe names cannot echo unbounded raw input back to callers.
// Truncation keeps the message prefix, which is what the taxonomy classifier
// matches on. Mirrors maxValidatorErrorLen in agent/internal/server/validate.go.
export const MAX_VALIDATOR_ERROR_LEN = 500;

function truncateValidatorMessage(s: string): string {
  const chars = Array.from(s);
  return chars.length <= MAX_VALIDATOR_ERROR_LEN
    ? s
    : chars.slice(0, MAX_VALIDATOR_ERROR_LEN).join("");
}

const C_DECL_RE = /^(struct|enum|union)(\s+[A-Za-z_][A-Za-z0-9_]*)?$/;
const PATH_BEARING_PROVIDERS = [
  "uprobe:",
  "uretprobe:",
  "usdt:",
  "u:",
  "ur:",
  "U:",
];

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

const ALLOWED_LIBC_ROOTS = [
  "/lib",
  "/lib64",
  "/usr/lib",
  "/usr/lib64",
] as const;
const MULTIARCH_DIR_RE = /^[a-z0-9_]+-linux-[a-z0-9]+$/;
const LIBC_SO_VERSION_RE = /^libc\.so(\.[0-9]+)*$/;
const LIBC_DASH_VER_SO_RE = /^libc-[0-9]+(\.[0-9]+)*\.so$/;
const UPROBE_SYMBOL_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const HOT_LIBC_SYMBOLS = new Set([
  "malloc",
  "free",
  "memcpy",
  "memset",
  "strlen",
  "read",
  "write",
]);

export type ValidateCatalogOption =
  { mode: "enforce"; known: readonly string[] } | { mode: "skip" };

export interface ValidateOptions {
  catalog: ValidateCatalogOption;
}

export type StaticErrorCode =
  | "CATALOG_UNAVAILABLE"
  | "VALIDATION_FAILED"
  | "PROBE_NOT_FOUND"
  | "LIMIT_EXCEEDED"
  | "BLOCKED_CALL"
  | "UNKNOWN_CALL";

export interface StaticResult {
  code?: StaticErrorCode;
  probes: string[];
  errors: string[];
  warnings: string[];
  probe_count: number;
}

function isLibcBasename(base: string): boolean {
  return LIBC_SO_VERSION_RE.test(base) || LIBC_DASH_VER_SO_RE.test(base);
}

function isAllowedLibcDir(dir: string): boolean {
  for (const root of ALLOWED_LIBC_ROOTS) {
    if (dir === root) return true;
    if (dir.startsWith(`${root}/`)) {
      const sub = dir.slice(root.length + 1);
      if (sub !== "" && !sub.includes("/") && MULTIARCH_DIR_RE.test(sub)) {
        return true;
      }
    }
  }
  return false;
}

function isAllowedLibcPath(target: string): boolean {
  if (
    target === "" ||
    !target.startsWith("/") ||
    target.endsWith("/") ||
    target.includes("//") ||
    /\s/.test(target)
  ) {
    return false;
  }
  const parts = target.slice(1).split("/");
  for (const part of parts) {
    if (part === "" || part === "." || part === "..") return false;
  }
  const idx = target.lastIndexOf("/");
  if (idx <= 0) return false;
  const dir = target.slice(0, idx);
  const base = target.slice(idx + 1);
  return isAllowedLibcDir(dir) && isLibcBasename(base);
}

function isAllowedLibcTarget(target: string): boolean {
  return target === "libc" || isAllowedLibcPath(target);
}

function parseUprobeProbe(pr: string): {
  provider: string;
  target: string;
  symbol: string;
  ok: boolean;
} {
  const colon = pr.indexOf(":");
  if (colon < 0) return { provider: "", target: "", symbol: "", ok: false };
  const provider = pr.slice(0, colon);
  if (provider !== "uprobe" && provider !== "uretprobe") {
    return { provider: "", target: "", symbol: "", ok: false };
  }
  const rest = pr.slice(colon + 1);
  const second = rest.indexOf(":");
  if (second < 0) {
    return { provider, target: rest, symbol: "", ok: false };
  }
  return {
    provider,
    target: rest.slice(0, second),
    symbol: rest.slice(second + 1),
    ok: true,
  };
}

function validateWildcardShape(pr: string, provider: string): string {
  if (
    provider !== "tracepoint" &&
    provider !== "kprobe" &&
    provider !== "kretprobe"
  ) {
    return `wildcard not allowed on provider ${provider}: ${pr}`;
  }
  const starCount = (pr.match(/\*/g) ?? []).length;
  if (/[?[\]]/.test(pr) || starCount !== 1 || !pr.endsWith("*")) {
    return `invalid wildcard pattern: ${pr}`;
  }
  const rest = pr.slice(provider.length + 1);
  if (provider === "tracepoint") {
    // No prefix-length floor: tracepoint patterns are catalog-bounded
    // (subsys must match a known catalog entry, expansion capped at
    // MAX_PROBES), while kprobe matches an unbounded kernel symbol
    // namespace and needs the >=3 floor below.
    const colon = rest.indexOf(":");
    if (colon <= 0) {
      return `invalid wildcard pattern: ${pr}`;
    }
    const event = rest.slice(colon + 1);
    if (event.includes(":")) {
      return `invalid wildcard pattern: ${pr}`;
    }
    return "";
  }
  const prefix = rest.slice(0, -1);
  if (prefix.includes(":")) {
    return `invalid wildcard pattern: ${pr}`;
  }
  if (prefix.length < 3) {
    return `wildcard too broad: ${pr}`;
  }
  return "";
}

// Edit distance cap for the near-miss tier: short queries get a floor so
// 1-2 char typos still match; longer queries scale with their length.
function suggestionDistanceCap(queryLen: number): number {
  return Math.max(4, Math.floor(queryLen / 4));
}

// Code-point Levenshtein distance; probe names are ASCII in practice but
// adversarial input may carry multibyte lookalikes (see unicode-lookalike).
export function levenshtein(a: string, b: string): number {
  const as = Array.from(a);
  const bs = Array.from(b);
  if (as.length === 0) return bs.length;
  if (bs.length === 0) return as.length;
  let prev = Array.from({ length: bs.length + 1 }, (_, i) => i);
  for (let i = 1; i <= as.length; i += 1) {
    const curr = [i];
    for (let j = 1; j <= bs.length; j += 1) {
      curr[j] = Math.min(
        (curr[j - 1] ?? 0) + 1,
        (prev[j] ?? 0) + 1,
        (prev[j - 1] ?? 0) + (as[i - 1] === bs[j - 1] ? 0 : 1),
      );
    }
    prev = curr;
  }
  return prev[bs.length] ?? 0;
}

// Suggestions must never point outside the uprobe allowlist: only libc (or a
// canonical libc path) may be proposed, whatever the query asked for.
function isSuggestible(k: string): boolean {
  const colon = k.indexOf(":");
  if (colon < 0) return true;
  const provider = k.slice(0, colon);
  if (provider !== "uprobe" && provider !== "uretprobe") return true;
  const rest = k.slice(colon + 1);
  const second = rest.indexOf(":");
  if (second < 0) return false;
  return isAllowedLibcTarget(rest.slice(0, second));
}

// Up to 5 nearest catalog names: full-prefix matches first, then same-scope
// near misses by edit distance, then (only when no prefix matched) the scope
// listing as a last resort. Mirrors suggestProbes in agent validate.go.
export function suggestProbes(pr: string, known: Set<string>): string {
  if (known.size === 0) return "";
  const colon = pr.indexOf(":");
  const provider = colon < 0 ? pr : pr.slice(0, colon);
  const cleanTarget = pr.endsWith("*") ? pr.slice(0, -1) : pr;
  let searchPrefix = `${provider}:`;
  if (colon >= 0 && provider === "tracepoint") {
    const second = cleanTarget.indexOf(":", colon + 1);
    if (second > colon + 1) {
      searchPrefix = cleanTarget.slice(0, second + 1);
    }
  }
  const inScope = (k: string): boolean => k.startsWith(searchPrefix);
  // Prefer the full pre-* prefix so long names narrow to their own
  // family before near misses and the scope listing kick in.
  const prefix = [...known]
    .filter((k) => isSuggestible(k) && inScope(k) && k.startsWith(cleanTarget))
    .sort();
  const prefixSet = new Set(prefix);
  const cap = suggestionDistanceCap(Array.from(cleanTarget).length);
  const near = [...known]
    .filter(
      (k) =>
        isSuggestible(k) &&
        inScope(k) &&
        !prefixSet.has(k) &&
        levenshtein(cleanTarget, k) <= cap,
    )
    .sort(
      (x, y) =>
        levenshtein(cleanTarget, x) - levenshtein(cleanTarget, y) ||
        (x < y ? -1 : x > y ? 1 : 0),
    );
  const nearSet = new Set(near);
  const rest =
    prefix.length === 0
      ? [...known]
          .filter((k) => isSuggestible(k) && inScope(k) && !nearSet.has(k))
          .sort()
      : [];
  const candidates = [...prefix, ...near, ...rest].slice(0, 5);
  if (candidates.length === 0) return "";
  return ` (did you mean: ${candidates.join(", ")}?)`;
}

const STATIC_VALIDATION_FAILED_PREFIXES = [
  "empty script",
  "script exceeds ",
  "blocked ",
  "invalid probe ",
  "invalid uprobe ",
  "invalid wildcard ",
  "no probes found",
  "provider not allowed:",
  "uprobe must ",
  "wildcard too broad:",
  "wildcard not allowed ",
];

function classifyStaticErrors(errors: string[]): StaticErrorCode {
  for (const err of errors) {
    if (err.startsWith("blocked call:")) return "BLOCKED_CALL";
  }
  for (const err of errors) {
    if (err.startsWith("unknown function call:")) return "UNKNOWN_CALL";
  }
  let code: StaticErrorCode = "VALIDATION_FAILED";
  for (const err of errors) {
    if (err.startsWith("catalog unavailable:")) return "CATALOG_UNAVAILABLE";
    if (err.startsWith("probe not found:")) return "PROBE_NOT_FOUND";
    if (
      err.startsWith("wildcard expands to too many probes:") ||
      err.startsWith("too many probes:")
    ) {
      code = "LIMIT_EXCEEDED";
      continue;
    }
    if (STATIC_VALIDATION_FAILED_PREFIXES.some((p) => err.startsWith(p))) {
      continue;
    }
  }
  return code;
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

// Token-level lexer for default-deny call validation (parity with the agent).
type TokenKind =
  "ident" | "number" | "string" | "punct" | "comment" | "preproc";

interface ScriptToken {
  kind: TokenKind;
  text: string;
}

const MAX_LEXER_TOKENS = 10000;
const MAX_NESTING_DEPTH = 128;

const DENIED_CALLS = new Set(["system", "signal", "override", "cat"]);

const ALLOWED_CALLS = new Set([
  "printf",
  "print",
  "count",
  "sum",
  "avg",
  "min",
  "max",
  "stats",
  "hist",
  "lhist",
  "delete",
  "clear",
  "zero",
  "str",
  "strncmp",
  "strlen",
  "buf",
  "ntop",
  "kstack",
  "ustack",
  "ksym",
  "usym",
  "time",
  "join",
  "exit",
  "cgroup_path",
  "cgroupid",
]);

const CALL_KEYWORDS = new Set([
  "if",
  "else",
  "for",
  "while",
  "return",
  "sizeof",
  "typeof",
  "unroll",
  "comptime",
]);

function isAsciiLetter(ch: string): boolean {
  return ch === "_" || (ch >= "A" && ch <= "Z") || (ch >= "a" && ch <= "z");
}

function isAsciiDigit(ch: string): boolean {
  return ch >= "0" && ch <= "9";
}

// Exported for tests: the lexer is the single source of truth for call
// detection, shared in behavior with the agent implementation.
export function lexScript(script: string): {
  toks: ScriptToken[];
  cleaned: string;
  errs: string[];
} {
  const toks: ScriptToken[] = [];
  const out: string[] = [];
  const errs: string[] = [];
  let seenControl = false;
  let seenNonAscii = false;
  const n = script.length;
  let i = 0;

  for (; i < n;) {
    if (toks.length > MAX_LEXER_TOKENS) {
      errs.push("script too complex: token limit exceeded");
      break;
    }
    const ch = script.charAt(i);
    const code = ch.charCodeAt(0);
    if (ch === "\n") {
      out.push(ch);
      i += 1;
      continue;
    }
    if (ch === " " || ch === "\t" || ch === "\r") {
      out.push(ch);
      i += 1;
      continue;
    }
    if (ch === "/" && i + 1 < n && script.charAt(i + 1) === "/") {
      let j = i + 2;
      while (j < n && script.charAt(j) !== "\n") j += 1;
      toks.push({ kind: "comment", text: script.slice(i, j) });
      out.push(" ");
      i = j;
      continue;
    }
    if (ch === "/" && i + 1 < n && script.charAt(i + 1) === "*") {
      let j = i + 2;
      let closed = false;
      while (j < n) {
        if (
          script.charAt(j) === "*" &&
          j + 1 < n &&
          script.charAt(j + 1) === "/"
        ) {
          j += 2;
          closed = true;
          break;
        }
        if (script.charAt(j) === "\n") out.push("\n");
        j += 1;
      }
      toks.push({ kind: "comment", text: script.slice(i, j) });
      out.push(" ");
      if (!closed) errs.push("blocked syntax: unclosed block comment");
      i = j;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      let closed = false;
      while (j < n) {
        if (script.charAt(j) === "\\") {
          j += script.charAt(j + 1) !== "\n" ? 2 : 1;
          continue;
        }
        if (script.charAt(j) === '"') {
          j += 1;
          closed = true;
          break;
        }
        if (script.charAt(j) === "\n") break;
        j += 1;
      }
      toks.push({ kind: "string", text: script.slice(i, j) });
      out.push(script.slice(i, j));
      if (!closed) errs.push("blocked syntax: unterminated string literal");
      i = j;
      continue;
    }
    if (ch === "#") {
      let j = i + 1;
      while (j < n && script.charAt(j) !== "\n") {
        if (
          script.charAt(j) === "\\" &&
          j + 1 < n &&
          script.charAt(j + 1) === "\n"
        ) {
          j += 2;
          continue;
        }
        if (
          script.charAt(j) === "\\" &&
          j + 2 < n &&
          script.charAt(j + 1) === "\r" &&
          script.charAt(j + 2) === "\n"
        ) {
          j += 3;
          continue;
        }
        j += 1;
      }
      toks.push({ kind: "preproc", text: script.slice(i, j) });
      out.push(" ");
      errs.push("blocked syntax: preprocessor directives are forbidden");
      i = j;
      continue;
    }
    if (ch === "\\" && i + 1 < n && script.charAt(i + 1) === "\n") {
      i += 2;
      continue;
    }
    if (
      ch === "\\" &&
      i + 2 < n &&
      script.charAt(i + 1) === "\r" &&
      script.charAt(i + 2) === "\n"
    ) {
      i += 3;
      continue;
    }
    if (code >= 0x80) {
      if (!seenNonAscii) {
        seenNonAscii = true;
        errs.push(
          "blocked syntax: non-ASCII characters are not allowed outside strings and comments",
        );
      }
      out.push(" ");
      const cp = script.codePointAt(i) ?? code;
      i += cp > 0xffff ? 2 : 1;
      continue;
    }
    if (code < 0x20 || code === 0x7f) {
      if (!seenControl) {
        seenControl = true;
        errs.push("blocked syntax: invalid control character");
      }
      out.push(" ");
      i += 1;
      continue;
    }
    if (isAsciiLetter(ch)) {
      const parts: string[] = [];
      let j = i;
      for (;;) {
        if (
          j < n &&
          (isAsciiLetter(script.charAt(j)) || isAsciiDigit(script.charAt(j)))
        ) {
          parts.push(script.charAt(j));
          j += 1;
          continue;
        }
        // Line continuations join identifiers, as in C, so a split
        // spelling still reads as the same call.
        if (
          j < n &&
          script.charAt(j) === "\\" &&
          j + 1 < n &&
          script.charAt(j + 1) === "\n"
        ) {
          j += 2;
          continue;
        }
        if (
          j < n &&
          script.charAt(j) === "\\" &&
          j + 2 < n &&
          script.charAt(j + 1) === "\r" &&
          script.charAt(j + 2) === "\n"
        ) {
          j += 3;
          continue;
        }
        break;
      }
      toks.push({ kind: "ident", text: parts.join("") });
      out.push(parts.join(""));
      i = j;
      continue;
    }
    if (isAsciiDigit(ch)) {
      const parts: string[] = [];
      let j = i;
      for (;;) {
        if (
          j < n &&
          (isAsciiLetter(script.charAt(j)) ||
            isAsciiDigit(script.charAt(j)) ||
            script.charAt(j) === ".")
        ) {
          parts.push(script.charAt(j));
          j += 1;
          continue;
        }
        if (
          j < n &&
          script.charAt(j) === "\\" &&
          j + 1 < n &&
          script.charAt(j + 1) === "\n"
        ) {
          j += 2;
          continue;
        }
        if (
          j < n &&
          script.charAt(j) === "\\" &&
          j + 2 < n &&
          script.charAt(j + 1) === "\r" &&
          script.charAt(j + 2) === "\n"
        ) {
          j += 3;
          continue;
        }
        break;
      }
      toks.push({ kind: "number", text: parts.join("") });
      out.push(parts.join(""));
      i = j;
      continue;
    }
    toks.push({ kind: "punct", text: ch });
    out.push(ch);
    i += 1;
  }

  return { toks, cleaned: out.join(""), errs };
}

// Every identifier call site: an identifier whose next non-comment token is
// an opening paren. A name in macro-definition position at depth 0 is a definition,
// not a call.
export function collectCalls(toks: ScriptToken[]): {
  calls: string[];
  tooDeep: boolean;
} {
  const calls: string[] = [];
  let depth = 0;
  let maxDepth = 0;
  let prevIdent = "";
  for (let idx = 0; idx < toks.length; idx += 1) {
    const t = toks[idx]!;
    if (t.kind === "comment") continue;
    let call = false;
    if (t.kind === "punct" && t.text.length === 1) {
      if (t.text === "(" || t.text === "{" || t.text === "[") {
        depth += 1;
        if (depth > maxDepth) maxDepth = depth;
      } else if (t.text === ")" || t.text === "}" || t.text === "]") {
        if (depth > 0) depth -= 1;
      }
    } else if (
      t.kind === "ident" &&
      !CALL_KEYWORDS.has(t.text) &&
      (prevIdent !== "macro" || depth > 0)
    ) {
      let j = idx + 1;
      while (j < toks.length && toks[j]!.kind === "comment") j += 1;
      if (
        j < toks.length &&
        toks[j]!.kind === "punct" &&
        toks[j]!.text === "("
      ) {
        call = true;
      }
    }
    if (call) calls.push(t.text);
    prevIdent = t.kind === "ident" ? t.text : "";
  }
  return { calls, tooDeep: maxDepth > MAX_NESTING_DEPTH };
}

function checkCalls(calls: string[]): string[] {
  const seen = new Set<string>();
  const errs: string[] = [];
  for (const name of calls) {
    if (seen.has(name)) continue;
    seen.add(name);
    if (DENIED_CALLS.has(name)) {
      errs.push(`blocked call: ${name} is forbidden`);
    } else if (!ALLOWED_CALLS.has(name)) {
      errs.push(`unknown function call: ${name} is not allowlisted`);
    }
  }
  errs.sort();
  return errs;
}

function advanceInString(s: string, i: number): [number, boolean] {
  if (s.charAt(i) === "\\") {
    i += 1;
    if (i < s.length && s.charAt(i) !== "\n") {
      i += 1;
    }
    return [i, true];
  }
  const ch = s.charAt(i);
  return [i + 1, ch !== '"' && ch !== "\n"];
}

function skipSpaces(s: string, i: number): number {
  while (i < s.length && /\s/.test(s.charAt(i))) {
    i += 1;
  }
  return i;
}

// Path-bearing providers accept slashes in target paths unless separated by whitespace/comma.
function startsPredicate(
  cleaned: string,
  headerStart: number,
  segmentStart: number,
  idx: number,
): boolean {
  if (idx === headerStart) return true;
  const prev = cleaned.charAt(idx - 1);
  if (/\s/.test(prev) || prev === ",") return true;
  const tok = cleaned.slice(segmentStart, idx).trimStart();
  return !PATH_BEARING_PROVIDERS.some((prefix) => tok.startsWith(prefix));
}

function scanPredicate(
  cleaned: string,
  start: number,
): { next: number; closed: boolean } {
  let i = start + 1; // consume opening '/'
  let inString = false;
  let parenDepth = 0;
  let bracketDepth = 0;
  const n = cleaned.length;
  while (i < n) {
    if (inString) {
      [i, inString] = advanceInString(cleaned, i);
      continue;
    }
    const ch = cleaned.charAt(i);
    if (ch === '"') {
      inString = true;
    } else if (ch === "(") {
      parenDepth += 1;
    } else if (ch === ")") {
      if (parenDepth > 0) parenDepth -= 1;
    } else if (ch === "[") {
      bracketDepth += 1;
    } else if (ch === "]") {
      if (bracketDepth > 0) bracketDepth -= 1;
    } else if (ch === "/" && parenDepth === 0 && bracketDepth === 0) {
      return { next: i + 1, closed: true };
    }
    i += 1;
  }
  return { next: i, closed: false };
}

function scanActionBlock(
  cleaned: string,
  start: number,
): { next: number; closed: boolean } {
  let i = start + 1; // consume opening '{'
  let depth = 1;
  let inString = false;
  const n = cleaned.length;
  while (i < n && depth > 0) {
    if (inString) {
      [i, inString] = advanceInString(cleaned, i);
      continue;
    }
    const ch = cleaned.charAt(i);
    if (ch === '"') {
      inString = true;
    } else if (ch === "{") {
      depth += 1;
    } else if (ch === "}") {
      depth -= 1;
    }
    i += 1;
  }
  return { next: i, closed: depth === 0 };
}

function resyncToActionBlock(
  cleaned: string,
  start: number,
): { next: number; foundOpen: boolean; foundClose: boolean } {
  let i = start;
  let inString = false;
  const n = cleaned.length;
  while (i < n) {
    if (inString) {
      [i, inString] = advanceInString(cleaned, i);
      continue;
    }
    const ch = cleaned.charAt(i);
    if (ch === '"') {
      inString = true;
      i += 1;
      continue;
    }
    if (ch === "{") return { next: i, foundOpen: true, foundClose: false };
    if (ch === "}") return { next: i, foundOpen: false, foundClose: true };
    i += 1;
  }
  return { next: i, foundOpen: false, foundClose: false };
}

function splitHeaderSegments(header: string): string[] {
  const segments: string[] = [];
  let start = 0;
  let inString = false;
  for (let i = 0; i < header.length;) {
    if (inString) {
      [i, inString] = advanceInString(header, i);
      continue;
    }
    const ch = header.charAt(i);
    if (ch === '"') {
      inString = true;
      i += 1;
      continue;
    }
    if (ch === ",") {
      segments.push(header.slice(start, i));
      i += 1;
      start = i;
      continue;
    }
    i += 1;
  }
  segments.push(header.slice(start));
  return segments;
}

function inspectHeaderSegment(seg: string): {
  hasUnquotedSpace: boolean;
  hasUnclosedQuote: boolean;
} {
  let hasUnquotedSpace = false;
  let hasUnclosedQuote = false;
  let inString = false;
  for (let i = 0; i < seg.length;) {
    const ch = seg.charAt(i);
    if (inString) {
      if (ch === "\n") hasUnclosedQuote = true;
      [i, inString] = advanceInString(seg, i);
      continue;
    }
    if (ch === '"') {
      inString = true;
      i += 1;
      continue;
    }
    if (/\s/.test(ch)) {
      hasUnquotedSpace = true;
    }
    i += 1;
  }
  if (inString) hasUnclosedQuote = true;
  return { hasUnquotedSpace, hasUnclosedQuote };
}

export function parseHeaderTargets(header: string): {
  targets: string[];
  errs: string[];
} {
  const targets: string[] = [];
  const errs: string[] = [];
  for (const raw of splitHeaderSegments(header)) {
    const seg = raw.trim();
    if (seg === "") {
      errs.push("invalid probe header: empty probe target");
      continue;
    }
    const { hasUnquotedSpace, hasUnclosedQuote } = inspectHeaderSegment(seg);
    if (hasUnclosedQuote) {
      errs.push("invalid probe header: unclosed quote in probe target");
      continue;
    }
    if (hasUnquotedSpace) {
      errs.push("invalid probe header: unexpected whitespace in probe target");
      continue;
    }
    if (seg.startsWith(":") || seg.endsWith(":")) {
      errs.push("invalid probe header: invalid colon in probe target");
      continue;
    }
    const colon = seg.indexOf(":");
    const provider = colon < 0 ? seg : seg.slice(0, colon);
    if (colon >= 0 && (provider === "BEGIN" || provider === "END")) {
      errs.push("invalid probe header: BEGIN/END cannot have target");
      continue;
    }
    if (/\s/.test(provider)) {
      errs.push("invalid probe header: unexpected whitespace in probe target");
      continue;
    }
    targets.push(seg);
  }
  return { targets, errs };
}

function extractProbes(cleaned: string): { probes: string[]; errs: string[] } {
  const probes: string[] = [];
  const errs: string[] = [];
  const n = cleaned.length;

  for (let i = 0; i < n;) {
    i = skipSpaces(cleaned, i);
    if (i >= n) break;
    if (cleaned.charAt(i) === "}") {
      errs.push("invalid probe syntax: unexpected closing brace");
      i += 1;
      continue;
    }

    const headerStart = i;
    let segmentStart = headerStart;
    let headerEnd = i;
    let inString = false;
    let hasPredicate = false;
    let foundOpenBrace = false;
    let foundTopCloseBrace = false;

    while (i < n) {
      if (inString) {
        [i, inString] = advanceInString(cleaned, i);
        continue;
      }
      const ch = cleaned.charAt(i);
      if (ch === '"') {
        inString = true;
        i += 1;
        continue;
      }
      if (ch === ",") {
        i += 1;
        segmentStart = i;
        continue;
      }
      if (ch === "{") {
        headerEnd = i;
        foundOpenBrace = true;
        break;
      }
      if (ch === "}") {
        headerEnd = i;
        foundTopCloseBrace = true;
        break;
      }
      if (
        ch === "/" &&
        startsPredicate(cleaned, headerStart, segmentStart, i)
      ) {
        headerEnd = i;
        hasPredicate = true;
        break;
      }
      i += 1;
    }

    if (foundTopCloseBrace) {
      errs.push("invalid probe syntax: unexpected closing brace");
      i += 1;
      continue;
    }
    if (hasPredicate) {
      const pred = scanPredicate(cleaned, i);
      if (!pred.closed) {
        errs.push("invalid probe syntax: unclosed predicate");
        break;
      }
      i = skipSpaces(cleaned, pred.next);
      if (i >= n) {
        errs.push("invalid probe header: missing action block");
        break;
      }
      if (cleaned.charAt(i) !== "{") {
        errs.push("invalid probe header: unexpected token after predicate");
        const resync = resyncToActionBlock(cleaned, i);
        i = resync.next;
        if (resync.foundClose) {
          errs.push("invalid probe syntax: unexpected closing brace");
          i += 1;
          continue;
        }
        if (!resync.foundOpen) break;
        foundOpenBrace = true;
      } else {
        foundOpenBrace = true;
      }
    } else if (!foundOpenBrace) {
      if (probes.length > 0) {
        errs.push("invalid probe header: missing action block");
      }
      break;
    }

    const header = cleaned.slice(headerStart, headerEnd).trim();
    if (header === "") {
      errs.push("invalid probe header: empty probe header");
    } else if (!hasPredicate && C_DECL_RE.test(header)) {
      const block = scanActionBlock(cleaned, i);
      if (!block.closed) {
        errs.push("invalid probe syntax: unclosed action block");
        break;
      }
      i = skipSpaces(cleaned, block.next);
      if (i < n && cleaned.charAt(i) === ";") i += 1;
      continue;
    } else {
      const parsed = parseHeaderTargets(header);
      probes.push(...parsed.targets);
      errs.push(...parsed.errs);
    }

    const block = scanActionBlock(cleaned, i);
    if (!block.closed) {
      errs.push("invalid probe syntax: unclosed action block");
      break;
    }
    i = block.next;
  }

  return { probes, errs };
}

export function staticValidate(
  script: string,
  options: ValidateOptions,
): StaticResult {
  if (
    options.catalog.mode === "enforce" &&
    options.catalog.known.length === 0
  ) {
    return {
      code: "CATALOG_UNAVAILABLE",
      probes: [],
      errors: ["catalog unavailable: probe catalog not ready"],
      warnings: [],
      probe_count: 0,
    };
  }
  const errors: string[] = [];
  const warnings: string[] = [];
  const seenHotSym = new Set<string>();
  if (script.trim() === "") {
    return {
      code: "VALIDATION_FAILED",
      probes: [],
      errors: ["empty script"],
      warnings,
      probe_count: 0,
    };
  }
  if (Buffer.byteLength(script, "utf8") > MAX_SCRIPT_BYTES) {
    return {
      code: "VALIDATION_FAILED",
      probes: [],
      errors: ["script exceeds 8 KB"],
      warnings,
      probe_count: 0,
    };
  }
  // The agent argv never carries --unsafe (fixed argv, no shell), so script
  // text mentioning it is judged like any other content: inside strings or
  // comments it is opaque to call detection, and stray text outside a probe
  // fails header parsing on both sides (see the shared parity vectors).
  const { toks, cleaned, errs: lexErrs } = lexScript(script);
  errors.push(...lexErrs);
  const { calls, tooDeep } = collectCalls(toks);
  if (tooDeep) errors.push("script too complex: nesting too deep");
  errors.push(...checkCalls(calls));
  const hasPrintfCall = calls.includes("printf");
  const { probes, errs: parseErrors } = extractProbes(cleaned);
  errors.push(...parseErrors);
  if (probes.length === 0 && parseErrors.length === 0) {
    errors.push("no probes found");
  }
  const enforceCatalog = options.catalog.mode === "enforce";
  const known = new Set<string>(
    options.catalog.mode === "enforce" ? options.catalog.known : [],
  );
  let probeCount = 0;
  let exceededByWildcard = false;
  for (const pr of probes) {
    const colon = pr.indexOf(":");
    const provider = colon < 0 ? pr : pr.slice(0, colon);
    if (!ALLOWED_PROVIDERS.has(provider)) {
      errors.push(`provider not allowed: ${provider}`);
      continue;
    }
    if (colon < 0 && provider !== "BEGIN" && provider !== "END") {
      errors.push(
        `invalid probe header: missing target for provider ${provider}`,
      );
      continue;
    }
    if (provider === "uprobe" || provider === "uretprobe") {
      if (/[*?[\]]/.test(pr)) {
        errors.push(`wildcard not allowed on provider ${provider}: ${pr}`);
        continue;
      }
      const parsed = parseUprobeProbe(pr);
      if (!parsed.ok) {
        errors.push(`invalid uprobe target: missing symbol in ${pr}`);
        continue;
      }
      if (!isAllowedLibcTarget(parsed.target)) {
        errors.push(`uprobe must target libc or canonical libc path: ${pr}`);
        continue;
      }
      if (!UPROBE_SYMBOL_RE.test(parsed.symbol)) {
        errors.push(`invalid uprobe symbol: ${parsed.symbol} in ${pr}`);
        continue;
      }
      if (
        HOT_LIBC_SYMBOLS.has(parsed.symbol) &&
        !seenHotSym.has(parsed.symbol)
      ) {
        seenHotSym.add(parsed.symbol);
        warnings.push(
          `Hot libc symbol "${parsed.symbol}" fires at high frequency; rely on in-kernel aggregation and agent rate caps.`,
        );
      }
      probeCount += 1;
      continue;
    }
    if (/[*?[\]]/.test(pr)) {
      const shapeErr = validateWildcardShape(pr, provider);
      if (shapeErr !== "") {
        errors.push(shapeErr);
        continue;
      }
      if (!enforceCatalog) {
        probeCount += 1;
        continue;
      }
      const n = expandCount(pr, known);
      if (n === 0) {
        errors.push(`probe not found: ${pr}${suggestProbes(pr, known)}`);
      } else if (n > MAX_PROBES) {
        errors.push(
          `wildcard expands to too many probes: ${pr} (${n} exceeds max ${MAX_PROBES})`,
        );
        exceededByWildcard = true;
      } else {
        warnings.push(
          `Wildcard probe ${pr} expands to ${n} probes; capped at ${MAX_PROBES}.`,
        );
      }
      probeCount += n;
      continue;
    }
    probeCount += 1;
    if (
      enforceCatalog &&
      provider !== "profile" &&
      provider !== "interval" &&
      provider !== "software" &&
      provider !== "BEGIN" &&
      provider !== "END"
    ) {
      if (!known.has(pr)) {
        errors.push(`probe not found: ${pr}${suggestProbes(pr, known)}`);
      }
    }
  }
  if (probeCount > MAX_PROBES && !exceededByWildcard) {
    errors.push(
      `too many probes: script attaches ${probeCount} probes (limit ${MAX_PROBES})`,
    );
  }
  if (hasPrintfCall) {
    const hot = probes.some(
      (p) => HIGH_FREQ.has(p) || p.startsWith("profile:"),
    );
    if (hot) {
      warnings.push("High-frequency probe; output is aggregated in-kernel.");
    } else if (probes.some((p) => p.includes("raw_syscalls"))) {
      warnings.push("High-frequency probe; output is aggregated in-kernel.");
    }
  }
  return {
    ...(errors.length > 0 ? { code: classifyStaticErrors(errors) } : {}),
    probes,
    errors: errors.map(truncateValidatorMessage),
    warnings: warnings.map(truncateValidatorMessage),
    probe_count: probeCount,
  };
}

export function truncateErrors(errors: string[], max = 20): string[] {
  return errors
    .map((e) => e.trim())
    .filter((e) => e !== "")
    .slice(0, max)
    .map((e) => e.slice(0, 500));
}
