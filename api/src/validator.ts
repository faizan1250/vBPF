export const MAX_SCRIPT_BYTES = 8 * 1024;
export const MAX_PROBES = 50;

const BLOCKED_CALLS = /\b(system|signal|override|cat)\s*\(/;
const INCLUDE_RE = /^\s*#\s*(include|define)\b/m;
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

// Strip // and /* */ comments and \\\r?\n line continuations outside
// double-quoted strings so regex checks match Go's StaticValidate identically.
function stripCommentsAndContinuations(script: string): {
  cleaned: string;
  unclosedComment: boolean;
} {
  const out: string[] = [];
  let inString = false;
  let unclosedComment = false;
  const n = script.length;

  for (let i = 0; i < n;) {
    const ch = script.charAt(i);
    if (inString) {
      if (ch === "\\") {
        out.push(ch);
        i += 1;
        if (i < n && script.charAt(i) !== "\n") {
          out.push(script.charAt(i));
          i += 1;
        }
        continue;
      }
      out.push(ch);
      if (ch === '"' || ch === "\n") {
        inString = false;
      }
      i += 1;
      continue;
    }

    if (ch === '"') {
      inString = true;
      out.push(ch);
      i += 1;
      continue;
    }
    if (ch === "\\") {
      if (i + 1 < n && script.charAt(i + 1) === "\n") {
        i += 2;
        continue;
      }
      if (
        i + 2 < n &&
        script.charAt(i + 1) === "\r" &&
        script.charAt(i + 2) === "\n"
      ) {
        i += 3;
        continue;
      }
      out.push(ch);
      i += 1;
      continue;
    }
    if (ch === "/" && i + 1 < n && script.charAt(i + 1) === "/") {
      i += 2;
      while (i < n && script.charAt(i) !== "\n") {
        i += 1;
      }
      out.push(" ");
      continue;
    }
    if (ch === "/" && i + 1 < n && script.charAt(i + 1) === "*") {
      i += 2;
      out.push(" ");
      let closed = false;
      while (i < n) {
        if (
          script.charAt(i) === "*" &&
          i + 1 < n &&
          script.charAt(i + 1) === "/"
        ) {
          i += 2;
          closed = true;
          break;
        }
        if (script.charAt(i) === "\n") {
          out.push("\n");
        }
        i += 1;
      }
      if (!closed) {
        unclosedComment = true;
      }
      continue;
    }
    out.push(ch);
    i += 1;
  }

  return { cleaned: out.join(""), unclosedComment };
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

function parseHeaderTargets(header: string): {
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
  const { cleaned, unclosedComment } = stripCommentsAndContinuations(script);
  if (unclosedComment) {
    errors.push("blocked syntax: unclosed block comment");
  }
  if (BLOCKED_CALLS.test(cleaned)) {
    errors.push("blocked call: system/signal/override/cat are forbidden");
  }
  if (INCLUDE_RE.test(cleaned)) {
    errors.push("blocked syntax: #include/#define are forbidden");
  }
  const { probes, errs: parseErrors } = extractProbes(cleaned);
  errors.push(...parseErrors);
  if (probes.length === 0 && parseErrors.length === 0) {
    errors.push("no probes found");
  }
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
  if (/\bprintf\s*\(/.test(cleaned)) {
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
