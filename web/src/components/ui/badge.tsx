import { cva, type VariantProps } from "class-variance-authority";
import type { HTMLAttributes } from "react";

import { cn } from "./cn.js";

const badge = cva(
  "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium",
  {
    variants: {
      tone: {
        neutral: "bg-accent text-accent-foreground",
        ok: "bg-emerald-500/15 text-emerald-400",
        warn: "bg-amber-500/15 text-amber-400",
        bad: "bg-destructive/15 text-red-400",
        info: "bg-sky-500/15 text-sky-400",
      },
    },
    defaultVariants: { tone: "neutral" },
  },
);

export interface BadgeProps
  extends HTMLAttributes<HTMLSpanElement>, VariantProps<typeof badge> {}

export function Badge({ className, tone, ...rest }: BadgeProps) {
  return <span className={cn(badge({ tone }), className)} {...rest} />;
}
