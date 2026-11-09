import { useEffect } from "react";
import { Moon, Sun } from "lucide-react";

import { ConfirmModal } from "./components/ConfirmModal.js";
import { HistoryPanel, recordRunToHistory } from "./components/HistoryPanel.js";
import { PromptPanel } from "./components/PromptPanel.js";
import { RunControls } from "./components/RunControls.js";
import { ScriptPanel } from "./components/ScriptPanel.js";
import { StderrDrawer } from "./components/StderrDrawer.js";
import { SummaryCard } from "./components/SummaryCard.js";
import { TopBar } from "./components/TopBar.js";
import { Button } from "./components/ui/button.js";
import { ViewSwitcher } from "./components/views/ViewSwitcher.js";
import { useDebouncedValidate } from "./hooks/useDebouncedValidate.js";
import { useRunStream } from "./hooks/useRunStream.js";
import { autoView } from "./lib/events.js";
import { useAppStore } from "./store/useAppStore.js";

function ThemeToggle() {
  const toggle = (): void => {
    document.documentElement.classList.toggle("dark");
  };
  return (
    <Button
      intent="ghost"
      size="sm"
      onClick={toggle}
      aria-label="Toggle color theme"
    >
      <Sun aria-hidden className="hidden dark:inline" />
      <Moon aria-hidden className="dark:hidden" />
    </Button>
  );
}

export function App() {
  const runId = useAppStore((s) => s.runId);
  const generation = useAppStore((s) => s.generation);
  const events = useAppStore((s) => s.events);
  const runPhase = useAppStore((s) => s.runPhase);
  const runError = useAppStore((s) => s.runError);

  useRunStream(runId, generation?.chart_type ?? null);
  const { validating } = useDebouncedValidate();

  useEffect(() => {
    if (runPhase === "done") recordRunToHistory(runId);
  }, [runPhase, runId]);

  const view = autoView(events, generation?.chart_type ?? null);

  return (
    <div className="flex min-h-screen flex-col bg-background text-foreground">
      <div className="flex items-start">
        <div className="flex-1">
          <TopBar />
        </div>
        <div className="border-b border-border bg-card px-2 py-1.5">
          <ThemeToggle />
        </div>
      </div>
      {runError && (
        <p
          role="alert"
          className="border-b border-border bg-destructive/10 px-4 py-2 text-sm text-red-400"
        >
          {runError}
        </p>
      )}
      <main className="grid flex-1 gap-4 p-4 lg:grid-cols-[320px_minmax(0,1fr)_minmax(0,1.2fr)]">
        <div className="flex min-w-0 flex-col gap-4">
          <PromptPanel />
          <HistoryPanel />
        </div>
        <div className="flex min-w-0 flex-col gap-4">
          <ScriptPanel validating={validating} />
          <RunControls />
        </div>
        <div className="flex min-w-0 flex-col gap-4">
          <ViewSwitcher autoView={view} hint={generation?.chart_type ?? null} />
          <SummaryCard />
          <StderrDrawer />
        </div>
      </main>
      <ConfirmModal />
    </div>
  );
}
