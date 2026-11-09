import { beforeEach, describe, expect, it } from "vitest";

import { useAppStore } from "../store/useAppStore.js";
import { stopCurrentRun } from "./runs.js";

describe("stopCurrentRun", () => {
  beforeEach(() => {
    useAppStore.setState({ runPhase: "running" });
  });

  it("resolves without touching phase when idle", async () => {
    await stopCurrentRun(null);
    expect(useAppStore.getState().runPhase).toBe("running");
  });

  it("stops fixture runs locally", async () => {
    await stopCurrentRun("run_fixture_1");
    expect(useAppStore.getState().runPhase).toBe("stopping");
  });
});
