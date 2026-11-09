import { beforeEach, describe, expect, it } from "vitest";

import { EVENT_RING_CAP, useAppStore } from "./useAppStore.js";
import type { EventEnvelope } from "../lib/api.js";

function envelope(seq: number): EventEnvelope {
  return { run_id: "r", seq, ts: seq, kind: "printf", data: "x" };
}

describe("useAppStore", () => {
  beforeEach(() => {
    useAppStore.setState({
      prompt: "",
      durationS: 10,
      generation: null,
      script: "",
      validationOk: null,
      validationErrors: [],
      events: [],
      dropped: 0,
      viewOverride: null,
    });
  });

  it("clamps duration to 1-60", () => {
    useAppStore.getState().setDuration(999);
    expect(useAppStore.getState().durationS).toBe(60);
    useAppStore.getState().setDuration(-5);
    expect(useAppStore.getState().durationS).toBe(1);
  });

  it("caps the event ring at 5000 and counts overflow", () => {
    const many = Array.from({ length: EVENT_RING_CAP + 100 }, (_, i) =>
      envelope(i),
    );
    useAppStore.getState().pushEvents(many);
    const state = useAppStore.getState();
    expect(state.events).toHaveLength(EVENT_RING_CAP);
    expect(state.dropped).toBe(100);
    expect(state.events[0]!.seq).toBe(100);
  });

  it("generation sets script and validation", () => {
    useAppStore.getState().setGeneration({
      generation_id: "g",
      script: "BEGIN { }",
      chart_type: "bar",
      explanation: "e",
      duration_s: 12,
      warnings: [],
      validation: { status: "ok", attempts: 1, errors: [] },
      based_on_recipe: null,
    });
    const state = useAppStore.getState();
    expect(state.script).toBe("BEGIN { }");
    expect(state.durationS).toBe(12);
    expect(state.validationOk).toBe(true);
  });
});
