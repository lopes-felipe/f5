import type * as React from "react";

import { cn } from "~/lib/utils";

/**
 * Sentence-case section heading used across Home, timeline, workflow and
 * settings surfaces: `text-2xs font-medium text-muted-foreground`, with an
 * optional count and trailing actions.
 */
function SectionLabel({
  children,
  count,
  trailing,
  as: Component = "h3",
  className,
  id,
}: {
  children: React.ReactNode;
  count?: number | undefined;
  trailing?: React.ReactNode;
  as?: "h2" | "h3" | "h4" | "div" | "span";
  className?: string | undefined;
  id?: string | undefined;
}) {
  return (
    <div className={cn("flex min-h-6 items-center gap-2", className)} data-slot="section-label">
      <Component id={id} className="text-2xs font-medium text-muted-foreground">
        {children}
        {count !== undefined ? <span className="ml-1.5 tabular-nums">{count}</span> : null}
      </Component>
      {trailing ? <div className="ml-auto flex items-center gap-1">{trailing}</div> : null}
    </div>
  );
}

export { SectionLabel };
