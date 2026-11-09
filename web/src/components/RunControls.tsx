import { useEffect, useState } from "react";
import { OctagonX, Play } from "lucide-react";

import { useAppStore } from "../store/useAppStore.js";
import { stopCurrentRun } from "./ConfirmModal.js";
import { Button } from "./ui/button.js";
import { Card, CardBody } from "./ui/card.js";

// Run controls: countdown, big Stop, keyboard shortcut (Ctrl/Cmd+Enter to
// confirm, Shift+Escape to stop). Shortcut ignores keystrokes inside the
// script editor except for stop.
export function RunControls() {
  const runPhase = useAppStore((s) => s.runPhase);
  const runId = useAppStore((s) => s.runId);
  const durationS = useAppStore((s) => s.durationS);
  const setConfirmOpen = useAppStore((s) => s.setConfirmOpen);
  const generation = useAppStore((s) => s.generation);
  const validationOk = useAppStore((s) => s.validationOk);
  const [elapsed, setElapsed] = useState(0);

  const active =
    runPhase === "running" ||
    runPhase === "starting" ||
    runPhase === "stopping";

  useEffect(() => {
    if (!active) {
      setElapsed(0);
      return;
    }
    setElapsed(0);
    const timer = window.setInterval(() => setElapsed((e) => e + 1), 1000);
    return () => window.clearInterval(timer);
  }, [active, runId]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const inField =
        e.target instanceof HTMLElement &&
        (e.target.tagName === "INPUT" ||
          e.target.tagName === "TEXTAREA" ||
          e.target.tagName === "SELECT");
      if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
        if (!active && generation && validationOk === true && !inField) {
          e.preventDefault();
          setConfirmOpen(true);
        }
      } else if (e.shiftKey && e.key === "Escape") {
        if (active) {
          e.preventDefault();
          void stopCurrentRun(runId);
        }
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [active, generation, validationOk, runId, setConfirmOpen]);

  if (!generation && !active) return null;

  const remaining = Math.max(0, durationS - elapsed);

  return (
    <Card>
      <CardBody className="flex items-center gap-3">
        <span className="text-sm text-muted-foreground" aria-live="polite">
          {runPhase === "done"
            ? "Run completed"
            : runPhase === "failed"
              ? "Run failed"
              : active
                ? `Running… ${remaining}s left`
                : "Ready to run"}
        </span>
        <div className="ml-auto flex gap-2">
          {!active && (
            <Button
              intent="primary"
              onClick={() => setConfirmOpen(true)}
              disabled={validationOk !== true}
            >
              <Play aria-hidden />
              Review & run
            </Button>
          )}
          {active && (
            <Button
              intent="danger"
              size="lg"
              onClick={() => void stopCurrentRun(runId)}
              disabled={runPhase === "stopping"}
            >
              <OctagonX aria-hidden />
              {runPhase === "stopping" ? "Stopping…" : "Stop"}
            </Button>
          )}
        </div>
      </CardBody>
    </Card>
  );
}
