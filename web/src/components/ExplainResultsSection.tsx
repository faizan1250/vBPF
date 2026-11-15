import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";

import {
  ApiError,
  explainResults,
  fixtureMode,
  type ExplainResultsResult,
} from "../lib/api.js";
import { Button } from "./ui/button.js";

const FIXTURE_RESULTS_EXPLANATION =
  "Fixture replay: run-output walkthrough for UI development without root.";

type ResultsStatus =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "done"; result: ExplainResultsResult }
  | { kind: "error"; message: string };

/**
 * Opt-in explanation of a script plus its run output. Default off: nothing is
 * sent until the user checks the consent box and clicks the button. The
 * default "Explain this probe" path (ExplainSection) never sees output.
 */
export function ExplainResultsSection({
  script,
  output,
}: {
  script: string;
  output: string;
}) {
  const [consented, setConsented] = useState(false);
  const [status, setStatus] = useState<ResultsStatus>({ kind: "idle" });
  const [explainedKey, setExplainedKey] = useState<string | null>(null);

  const key = `${script}\n---\n${output}`;
  // A new script or new output invalidates a prior walkthrough.
  useEffect(() => {
    if (explainedKey !== null && explainedKey !== key) {
      setExplainedKey(null);
      setStatus({ kind: "idle" });
    }
  }, [key, explainedKey]);

  const ready =
    script.trim() !== "" && output.trim() !== "" && consented === true;

  const run = async (): Promise<void> => {
    if (!ready || status.kind === "loading") return;
    setStatus({ kind: "loading" });
    try {
      const result = fixtureMode()
        ? {
            explanation: FIXTURE_RESULTS_EXPLANATION,
            cached: false,
            model: "fixture",
          }
        : await explainResults(script, output);
      setExplainedKey(key);
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
        <h3 className="text-xs font-semibold">Explain these results</h3>
        <Button
          size="sm"
          intent="secondary"
          disabled={!ready || status.kind === "loading"}
          onClick={() => void run()}
        >
          {status.kind === "loading" ? (
            <Loader2 aria-hidden className="animate-spin" />
          ) : null}
          {status.kind === "error"
            ? "Retry results explanation"
            : "Explain these results"}
        </Button>
      </div>
      <p className="text-[11px] text-muted-foreground">
        Optional. Run output may contain process names, file paths, or command
        lines. It is sent to the configured LLM provider along with the script
        only when you opt in — otherwise it stays on this machine.
      </p>
      <label className="mt-1 flex items-start gap-2 text-[11px] text-muted-foreground">
        <input
          type="checkbox"
          checked={consented}
          onChange={(e) => setConsented(e.target.checked)}
          aria-label="I understand run output will leave this machine"
          className="mt-0.5"
        />
        <span>
          I understand run output will leave this machine ({output.length} chars
          of output, script {script.length} chars).
        </span>
      </label>
      {status.kind === "loading" && (
        <p className="text-sm text-muted-foreground" aria-live="polite">
          Explaining results…
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
