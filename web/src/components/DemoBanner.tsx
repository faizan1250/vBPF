import { FlaskConical } from "lucide-react";

// Static-demo banner (fixture mode only): the app runs with no backend,
// so every run replays recorded data.
export function DemoBanner() {
  return (
    <p
      role="status"
      className="flex items-center justify-center gap-2 border-b border-amber-500/40 bg-amber-500/10 px-4 py-1.5 text-center text-xs font-medium text-amber-300"
    >
      <FlaskConical aria-hidden className="size-3.5 shrink-0" />
      Demo mode: recorded data, nothing is executed
    </p>
  );
}
