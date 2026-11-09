import type { HTMLAttributes } from "react";

import { cn } from "./cn.js";

export function Card({ className, ...rest }: HTMLAttributes<HTMLElement>) {
  return (
    <section
      className={cn(
        "rounded-lg border border-border bg-card text-card-foreground",
        className,
      )}
      {...rest}
    />
  );
}

export function CardHeader({
  className,
  ...rest
}: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn("border-b border-border px-4 py-3", className)}
      {...rest}
    />
  );
}

export function CardTitle({
  className,
  ...rest
}: HTMLAttributes<HTMLHeadingElement>) {
  return (
    <h2
      className={cn("text-sm font-semibold tracking-tight", className)}
      {...rest}
    />
  );
}

export function CardBody({
  className,
  ...rest
}: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("px-4 py-3", className)} {...rest} />;
}
