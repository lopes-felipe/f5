import type { ReactNode } from "react";

import { cn } from "../../lib/utils";

/**
 * Standard settings card: rounded bordered section with a title, optional description,
 * optional header actions (status badges, small buttons) and body content.
 * `searchTarget` wires the card to settings search (`data-settings-search-target`).
 */
export function SettingsCard({
  title,
  description,
  actions,
  searchTarget,
  className,
  children,
}: {
  readonly title: ReactNode;
  readonly description?: ReactNode;
  readonly actions?: ReactNode;
  readonly searchTarget?: string;
  readonly className?: string;
  readonly children?: ReactNode;
}) {
  return (
    <section
      className={cn("rounded-2xl border border-border bg-card p-5", className)}
      data-settings-search-target={searchTarget}
    >
      <div
        className={cn(
          "mb-4",
          actions ? "flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between" : undefined,
        )}
      >
        <div className="min-w-0">
          <h2 className="text-sm font-medium text-foreground">{title}</h2>
          {description ? <p className="mt-1 text-xs text-muted-foreground">{description}</p> : null}
        </div>
        {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
      </div>
      {children}
    </section>
  );
}
