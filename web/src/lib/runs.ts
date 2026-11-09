import { stopRun } from "./api.js";
import { useAppStore } from "../store/useAppStore.js";

// Best-effort stop: marks stopping immediately, then asks the agent.
// Fixture runs have no backend, so they stop locally.
export function stopCurrentRun(runId: string | null): Promise<void> {
  if (!runId) return Promise.resolve();
  const store = useAppStore.getState();
  if (runId.startsWith("run_fixture_")) {
    store.setRunPhase("stopping");
    return Promise.resolve();
  }
  store.setRunPhase("stopping");
  return stopRun(runId)
    .catch(() => {
      // Best-effort: the agent may already have reaped the run on timeout.
    })
    .then(() => undefined);
}
