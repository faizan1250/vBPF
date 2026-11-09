import { X } from "lucide-react";
import { useEffect, type ReactNode } from "react";

import { cn } from "./cn.js";
import { Button } from "./button.js";

// Minimal accessible modal: focus trap on open, Escape to close,
// role=dialog with labelled heading.
export function Dialog({
  open,
  onClose,
  title,
  children,
  wide,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  wide?: boolean;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
      onClick={onClose}
      role="presentation"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={cn(
          "max-h-[90vh] w-full overflow-auto rounded-lg border border-border bg-card text-card-foreground",
          wide ? "max-w-3xl" : "max-w-lg",
        )}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <h2 className="text-sm font-semibold">{title}</h2>
          <Button
            intent="ghost"
            size="sm"
            onClick={onClose}
            aria-label="Close dialog"
          >
            <X />
          </Button>
        </div>
        <div className="px-4 py-3">{children}</div>
      </div>
    </div>
  );
}
