// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";

import { exportEntry, listHistory, sampleEvents, saveHistory } from "./history.js";
import type { EventEnvelope } from "./api.js";

function envelope(seq: number): EventEnvelope {
  return { run_id: "r", seq, ts: seq, kind: "printf", data: "x" };
}

describe("history", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("samples long runs down to 200 events", () => {
    const events = Array.from({ length: 1000 }, (_, i) => envelope(i));
    expect(sampleEvents(events)).toHaveLength(200);
  });

  it("round-trips entries through localStorage", () => {
    saveHistory({
      id: "1",
      title: "t",
      createdAt: 1,
      prompt: "p",
      script: "s",
      chartType: "bar",
      explanation: "e",
      durationS: 10,
      warnings: [],
      runId: "r",
      exitReason: "completed",
      eventsSample: [envelope(0)],
    });
    expect(listHistory()).toHaveLength(1);
  });

  it("exports prompt, script and samples", () => {
    const text = exportEntry({
      id: "1",
      title: "t",
      createdAt: 1,
      prompt: "p",
      script: "s",
      chartType: "bar",
      explanation: "e",
      durationS: 10,
      warnings: ["w"],
      runId: "r",
      exitReason: "completed",
      eventsSample: [],
    });
    const parsed = JSON.parse(text) as Record<string, unknown>;
    expect(parsed["prompt"]).toBe("p");
    expect(parsed["script"]).toBe("s");
    expect(parsed["warnings"]).toEqual(["w"]);
  });
});
