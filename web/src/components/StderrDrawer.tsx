import { useState } from "react";
import { ChevronDown, Terminal } from "lucide-react";

import { useAppStore } from "../store/useAppStore.js";
import { cn } from "./ui/cn.js";

export function StderrDrawer() {
  const stderrLines = useAppStore((s) => s.stderrLines);
  const [open, setOpen] = useState(false);

  if (stderrLines.length === 0) return null;

  return (
    <div className="rounded-lg border border-border bg-card">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 px-4 py-2 text-left text-xs text-muted-foreground hover:text-foreground"
      >
        <Terminal aria-hidden className="size-3.5" />
        Probe log ({stderrLines.length})
        <ChevronDown aria-hidden className={cn("ml-auto size-4 transition-transform", open && "rotate-180")} />
      </button>
      {open && (
        <pre className="max-h-48 overflow-auto border-t border-border p-3 font-mono text-[11px] text-muted-foreground">
          {stderrLines.join("\n")}
        </pre>
      )}
    </div>
  );
}
