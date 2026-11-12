// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";

import { listHistory } from "../lib/history.js";
import { useAppStore } from "../store/useAppStore.js";
import { recordRunToHistory } from "./HistoryPanel.js";

describe("recordRunToHistory", () => {
  beforeEach(() => {
    localStorage.clear();
    useAppStore.setState({
      prompt: "count syscalls",
      script: "BEGIN { }",
      generation: null,
      durationS: 10,
      runId: "run_once",
      runOrigin: "edited",
      summary: null,
    });
  });

  it("records once per runId across repeated calls", () => {
    recordRunToHistory("run_once");
    recordRunToHistory("run_once");
    const entries = listHistory();
    expect(entries).toHaveLength(1);
    expect(entries[0]!.runId).toBe("run_once");
  });

  it("records the server-derived origin for every run", () => {
    for (const origin of ["generated", "edited", "recipe"] as const) {
      const runId = `run_origin_${origin}`;
      useAppStore.setState({ runId, runOrigin: origin });
      recordRunToHistory(runId);
    }
    expect(listHistory().map((entry) => entry.origin)).toEqual([
      "recipe",
      "edited",
      "generated",
    ]);
  });
});
