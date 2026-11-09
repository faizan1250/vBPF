import { useMutation } from "@tanstack/react-query";
import { Play, TriangleAlert } from "lucide-react";

import { ApiError, createRun, fixtureMode, stopRun } from "../lib/api.js";
import { useAppStore } from "../store/useAppStore.js";
import { Badge } from "./ui/badge.js";
import { Button } from "./ui/button.js";
import { Dialog } from "./ui/dialog.js";

// Confirm gate: shows the exact script + duration + warnings. The run
// button stays disabled until live validation reports ok.
export function ConfirmModal() {
  const confirmOpen = useAppStore((s) => s.confirmOpen);
  const setConfirmOpen = useAppStore((s) => s.setConfirmOpen);
  const validationOk = useAppStore((s) => s.validationOk);
  const script = useAppStore((s) => s.script);
  const durationS = useAppStore((s) => s.durationS);
  const generation = useAppStore((s) => s.generation);
  const warnings = generation?.warnings ?? [];
  const request = { script, durationS, warnings };
  const setRunId = useAppStore((s) => s.setRunId);
  const setRunPhase = useAppStore((s) => s.setRunPhase);
  const setRunError = useAppStore((s) => s.setRunError);
  const clearRun = useAppStore((s) => s.clearRun);

  const start = useMutation({
    mutationFn: () => {
      if (fixtureMode()) {
        return Promise.resolve({
          run_id: `run_fixture_${Date.now()}`,
          state: "running",
        });
      }
      return createRun(request.script, request.durationS);
    },
    onSuccess: (result) => {
      clearRun();
      setRunId(result.run_id);
      setRunPhase("starting");
      setConfirmOpen(false);
    },
    onError: (err) => {
      const message =
        err instanceof ApiError
          ? `${err.code}: ${err.message}`
          : "failed to start run";
      setRunError(message);
      setRunPhase("failed");
      setConfirmOpen(false);
    },
  });

  const canRun = validationOk === true && !start.isPending;

  return (
    <Dialog
      open={confirmOpen}
      onClose={() => setConfirmOpen(false)}
      title="Confirm probe run"
      wide
    >
      <div className="flex flex-col gap-3">
        <p className="text-sm text-muted-foreground">
          This attaches a real eBPF probe to your kernel for{" "}
          <strong className="text-foreground">{request.durationS}s</strong>.
          Review the exact script that will run:
        </p>
        <pre className="max-h-64 overflow-auto rounded-md border border-border bg-background p-3 font-mono text-xs">
          {request.script}
        </pre>
        {request.warnings.length > 0 ? (
          <ul className="flex flex-col gap-1">
            {request.warnings.map((w) => (
              <li
                key={w}
                className="flex items-start gap-1.5 text-xs text-amber-400"
              >
                <TriangleAlert
                  aria-hidden
                  className="mt-0.5 size-3.5 shrink-0"
                />
                {w}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-xs text-muted-foreground">No warnings.</p>
        )}
        {validationOk !== true && (
          <Badge tone="bad" role="alert" className="self-start">
            Validation must be ok before running
          </Badge>
        )}
        <div className="flex justify-end gap-2">
          <Button intent="ghost" onClick={() => setConfirmOpen(false)}>
            Cancel
          </Button>
          <Button
            intent="primary"
            disabled={!canRun}
            onClick={() => start.mutate()}
          >
            <Play aria-hidden />
            Run this probe
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

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
