import { describe, expect, it } from "vitest";

import { ScriptSchema } from "@vbpf/schemas";

describe("ScriptSchema measures the cap in UTF-8 bytes", () => {
  it("rejects multi-byte input over 8 KiB with fewer chars", () => {
    const script = `BEGIN { @x = count(); }\n// ${"é".repeat(4090)}`;
    expect(script.length).toBeLessThanOrEqual(8 * 1024);
    expect(Buffer.byteLength(script, "utf8")).toBeGreaterThan(8 * 1024);
    expect(ScriptSchema.safeParse(script).success).toBe(false);
  });

  it("accepts multi-byte input within the byte budget", () => {
    const script = "BEGIN { @x = count(); }\n// héllo wörld\n";
    expect(Buffer.byteLength(script, "utf8")).toBeLessThanOrEqual(8 * 1024);
    expect(ScriptSchema.safeParse(script).success).toBe(true);
  });

  it("holds the ASCII boundary at exactly 8192 bytes", () => {
    expect(ScriptSchema.safeParse("a".repeat(8192)).success).toBe(true);
    expect(ScriptSchema.safeParse("a".repeat(8193)).success).toBe(false);
  });
});
