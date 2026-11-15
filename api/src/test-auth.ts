// Test-only: injects the API bearer token into every fetch() issued from the
// importing test file, so the pre-existing suites (which predate the gate)
// keep exercising the routes rather than every call site growing a header.
// The wrapper never overwrites an explicitly set Authorization value, and the
// gate's own tests (api-auth.test.ts) bypass it via node:http/raw fetch.
export function installTestApiAuth(token: string): void {
  const rawFetch = globalThis.fetch;
  globalThis.fetch = (async (
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ) => {
    const headers = new Headers((init?.headers ?? {}) as HeadersInit);
    if (!headers.has("authorization")) {
      headers.set("authorization", `Bearer ${token}`);
    }
    return rawFetch(input, { ...init, headers });
  }) as typeof fetch;
}
