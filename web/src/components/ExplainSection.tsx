import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";

import {
  ApiError,
  explainScript,
  fixtureMode,
  type ExplainResult,
} from "../lib/api.js";
import { Button } from "./ui/button.js";

const FIXTURE_EXPLANATION =
  "Fixture replay: probe walkthrough for UI development without root.";

type ExplainStatus =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "done"; result: ExplainResult }
  | { kind: "error"; message: string };

export function ExplainSection({ script }: { script: string }) {
  const [status, setStatus] = useState<ExplainStatus>({ kind: "idle" });
  const [explainedScript, setExplainedScript] = useState<string | null>(null);

  // An edit after explaining invalidates the walkthrough.
  useEffect(() => {
    if (explainedScript !== null && explainedScript !== script) {
      setExplainedScript(null);
      setStatus({ kind: "idle" });
    }
  }, [script, explainedScript]);

  const run = async (): Promise<void> => {
    setStatus({ kind: "loading" });
    try {
      const result = fixtureMode()
        ? { explanation: FIXTURE_EXPLANATION, cached: false, model: "fixture" }
        : await explainScript(script);
      setExplainedScript(script);
      setStatus({ kind: "done", result });
    } catch (err) {
      const message =
        err instanceof ApiError
          ? `${err.code}: ${err.message}`
          : "explanation failed";
      setStatus({ kind: "error", message });
    }
  };

  return (
    <div>
      <div className="mb-1 flex items-center justify-between">
        <h3 className="text-xs font-semibold">Explanation</h3>
        <Button
          size="sm"
          intent="secondary"
          disabled={status.kind === "loading" || script.trim() === ""}
          onClick={() => void run()}
        >
          {status.kind === "loading" ? (
            <Loader2 aria-hidden className="animate-spin" />
          ) : null}
          {status.kind === "error" ? "Retry explanation" : "Explain this probe"}
        </Button>
      </div>
      {status.kind === "loading" && (
        <p className="text-sm text-muted-foreground" aria-live="polite">
          Explaining…
        </p>
      )}
      {status.kind === "error" && (
        <p className="text-sm text-red-400" role="alert">
          {status.message}
        </p>
      )}
      {status.kind === "done" && (
        <div aria-live="polite">
          <p className="text-sm text-muted-foreground">
            {status.result.explanation}
          </p>
          <p className="mt-1 text-[11px] text-muted-foreground">
            via {status.result.model}
            {status.result.cached ? " · cached" : ""}
          </p>
        </div>
      )}
    </div>
  );
}
