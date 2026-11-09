import { describe, expect, it } from "vitest";

import type { EventEnvelope } from "./api.js";
import {
  accumulateSeries,
  autoView,
  bucketLabel,
  histBuckets,
  mapEntries,
  printfText,
  stderrText,
  summaryFrom,
} from "./events.js";

function envelope(kind: EventEnvelope["kind"], data: unknown): EventEnvelope {
  return { run_id: "run_1", seq: 1, ts: 1000, kind, data };
}

describe("autoView", () => {
  it("prefers hint over content", () => {
    expect(autoView([envelope("map", {})], "timeseries")).toBe("timeseries");
    expect(autoView([envelope("map", {})], "events")).toBe("events");
  });
  it("selects histogram for hist kinds", () => {
    expect(autoView([envelope("hist", {})], null)).toBe("histogram");
  });
  it("selects timeseries for repeated maps", () => {
    const maps = [1, 2, 3].map((i) => ({ ...envelope("map", {}), seq: i }));
    expect(autoView(maps, null)).toBe("timeseries");
  });
  it("selects bar for a single map", () => {
    expect(autoView([envelope("map", {})], null)).toBe("bar");
  });
  it("defaults to events", () => {
    expect(autoView([], null)).toBe("events");
  });
});

describe("mapEntries", () => {
  it("unwraps named maps and sorts desc", () => {
    expect(mapEntries({ "@syscalls": { bash: 2, init: 9 } })).toEqual([
      ["init", 9],
      ["bash", 2],
    ]);
  });
  it("drops non-numeric values", () => {
    expect(mapEntries({ a: "x", b: 1 })).toEqual([["b", 1]]);
  });
});

describe("histBuckets", () => {
  it("parses power-of-two buckets", () => {
    const buckets = histBuckets({
      "@lat_us": [
        { min: 64, max: 127, count: 21 },
        { min: 128, max: 255, count: 0 },
      ],
    });
    expect(buckets).toHaveLength(2);
    expect(bucketLabel(buckets[0]!)).toBe("64–127");
  });
  it("ignores malformed entries", () => {
    expect(histBuckets({ "@h": [{ min: "x" }] })).toEqual([]);
  });
});

describe("accumulateSeries", () => {
  it("keeps top-5 plus other", () => {
    const snaps = [0, 1, 2].map((t) => ({
      ts: 1000 + t * 1000,
      rows: [
        ["k1", 10],
        ["k2", 9],
        ["k3", 8],
        ["k4", 7],
        ["k5", 6],
        ["k6", 5],
        ["k7", 1],
      ] as Array<[string, number]>,
    }));
    const { points, keys } = accumulateSeries(snaps, 5);
    expect(keys).toEqual(["k1", "k2", "k3", "k4", "k5", "other"]);
    expect(points[0]!.other).toBe(6);
    expect(points).toHaveLength(3);
  });
  it("caps at 1200 points", () => {
    const snaps = Array.from({ length: 1300 }, (_, i) => ({
      ts: i * 1000,
      rows: [["a", i]] as Array<[string, number]>,
    }));
    expect(accumulateSeries(snaps).points).toHaveLength(1200);
  });
});

describe("summaryFrom", () => {
  it("parses snake_case summary", () => {
    expect(
      summaryFrom({
        events: 10,
        bytes: 99,
        dropped: 1,
        duration_s: 10,
        exit_reason: "completed",
      }),
    ).toEqual({
      events: 10,
      bytes: 99,
      dropped: 1,
      durationS: 10,
      exitReason: "completed",
    });
  });
  it("rejects non-summary payloads", () => {
    expect(summaryFrom({ foo: 1 })).toBeNull();
  });
});

describe("text helpers", () => {
  it("stringifies printf payloads", () => {
    expect(printfText("hi\n")).toBe("hi\n");
    expect(printfText({ a: 1 })).toBe('{"a":1}');
  });
  it("extracts stderr text", () => {
    expect(stderrText("warn")).toBe("warn");
    expect(stderrText({ text: "x" })).toBe("x");
    expect(stderrText({ n: 1 })).toBeNull();
  });
});
