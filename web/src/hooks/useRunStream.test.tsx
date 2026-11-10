// @vitest-environment jsdom
import { renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useAppStore } from "../store/useAppStore.js";
import { useRunStream } from "./useRunStream.js";

vi.mock("../lib/api.js", () => ({ fixtureMode: () => true }));

describe("useRunStream", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useAppStore.setState({
      runPhase: "idle",
      runId: null,
      runError: null,
      events: [],
      dropped: 0,
      summary: null,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("ignores a stale runId when a new generation lands", () => {
    useAppStore.getState().setRunId("run_fixture_1");
    useAppStore.getState().setRunPhase("awaiting-confirm");
    const { rerender, unmount } = renderHook(
      ({ chart }: { chart: string }) => useRunStream("run_fixture_1", chart),
      { initialProps: { chart: "bar" } },
    );
    // New generation switches the chart while the old runId lingers.
    rerender({ chart: "events" });
    vi.advanceTimersByTime(1_000);
    expect(useAppStore.getState().runPhase).toBe("awaiting-confirm");
    expect(useAppStore.getState().events).toHaveLength(0);
    unmount();
  });

  it("attaches a freshly confirmed run", () => {
    useAppStore.getState().setRunId("run_fixture_9");
    useAppStore.getState().setRunPhase("starting");
    const { unmount } = renderHook(() => useRunStream("run_fixture_9", "bar"));
    expect(useAppStore.getState().runPhase).toBe("running");
    vi.advanceTimersByTime(500);
    expect(useAppStore.getState().events.length).toBeGreaterThan(0);
    unmount();
  });
});
