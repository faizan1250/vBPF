import { randomBytes, timingSafeEqual } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";

// Bearer-token gate for the API itself (loopback + Host/Origin gates stay).
// Any local process could previously call the API; now only a holder of the
// API token file (0600, like the agent token) can. The file is generated on
// first API start when missing, so a fresh clone keeps working.

export class ApiTokenError extends Error {
  constructor(message = "api token unreadable") {
    super(message);
    this.name = "ApiTokenError";
  }
}

const tokenCache = new Map<string, { mtimeMs: number; token: string }>();

function secureTokenFile(path: string): void {
  chmodSync(path, 0o600);
  if (process.platform !== "win32") {
    const perm = statSync(path).mode & 0o777;
    if (perm !== 0o600) {
      throw new ApiTokenError(
        `insecure api token permissions: ${perm.toString(8)} (expected 600)`,
      );
    }
  }
}

function loadCached(path: string): string | null {
  let mtimeMs = -1;
  try {
    mtimeMs = statSync(path).mtimeMs;
  } catch {
    return null;
  }
  const cached = tokenCache.get(path);
  if (cached !== undefined && cached.mtimeMs === mtimeMs) return cached.token;
  let raw: string;
  try {
    raw = readFileSync(path, "utf8").trim();
  } catch {
    tokenCache.delete(path);
    return null;
  }
  if (raw === "") {
    tokenCache.delete(path);
    return null;
  }
  tokenCache.set(path, { mtimeMs, token: raw });
  return raw;
}

// Reads the API token, generating a 0600 file on first start (mirrors the
// agent's LoadOrCreateToken; the API is the sole writer). Throws
// ApiTokenError when the file cannot be read or secured — fail closed.
export function loadOrCreateApiToken(path: string): string {
  const existing = loadCached(path);
  if (existing !== null) {
    secureTokenFile(path);
    return existing;
  }
  const token = randomBytes(32).toString("hex");
  const dir = dirname(path);
  if (dir !== "" && dir !== ".")
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(path, `${token}\n`, { mode: 0o600 });
  secureTokenFile(path);
  tokenCache.delete(path);
  const created = loadCached(path);
  if (created === null) throw new ApiTokenError("api token unreadable");
  return created;
}

// Per-request read through the mtime cache (picks up rotation). Never
// generates: missing/unreadable at request time is a 500, not a silent mint.
export function readApiToken(path: string): string {
  const token = loadCached(path);
  if (token === null) throw new ApiTokenError("api token unreadable");
  return token;
}

// Constant-time comparison for fixed 64-char hex bearer tokens
// (randomBytes(32).hex, see loadOrCreateApiToken). Length and charset are
// checked first so timingSafeEqual always sees equal-length 32-byte buffers.
export function tokensEqual(a: string, b: string): boolean {
  if (a.length !== 64 || b.length !== 64) return false;
  if (!/^[0-9a-fA-F]{64}$/.test(a) || !/^[0-9a-fA-F]{64}$/.test(b))
    return false;
  const ba = Buffer.from(a, "hex");
  const bb = Buffer.from(b, "hex");
  if (ba.length !== 32 || bb.length !== 32) return false;
  return timingSafeEqual(ba, bb);
}

export function bearerToken(header: string | string[] | undefined): string {
  const raw = Array.isArray(header) ? (header[0] ?? "") : (header ?? "");
  if (raw === "") return "";
  const space = raw.indexOf(" ");
  if (space < 0) return "";
  if (!/^bearer$/i.test(raw.slice(0, space))) return "";
  return raw.slice(space + 1).trim();
}

// Browsers cannot set headers on WebSocket upgrades, so /ws/* also accepts
// ?token=. The value is redacted from every log line (see redactTokenUrl).
export function wsQueryToken(rawUrl: string | undefined): string {
  if (typeof rawUrl !== "string" || rawUrl === "") return "";
  const q = rawUrl.indexOf("?");
  if (q < 0) return "";
  for (const part of rawUrl.slice(q + 1).split("&")) {
    const eq = part.indexOf("=");
    const key = eq < 0 ? part : part.slice(0, eq);
    if (key === "token") {
      try {
        return decodeURIComponent(eq < 0 ? "" : part.slice(eq + 1)).trim();
      } catch {
        return "";
      }
    }
  }
  return "";
}

export function redactTokenUrl(url: string | undefined): string | undefined {
  if (typeof url !== "string") return url;
  return url.replace(/([?&]token=)[^&#]*/g, "$1[REDACTED]");
}
