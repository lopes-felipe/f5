import type * as React from "react";

import { cn } from "~/lib/utils";

export interface UnderlineTab<Value extends string> {
  readonly value: Value;
  readonly label: React.ReactNode;
  /** Trailing content inside the tab, such as a count badge. */
  readonly adornment?: React.ReactNode;
}

/**
 * Page-level tabs drawn as a bottom-bordered row with an underline on the active
 * tab (the PR hub's tab style). Arrow keys move between tabs.
 */
function UnderlineTabs<Value extends string>({
  tabs,
  value,
  onValueChange,
  className,
  "aria-label": ariaLabel,
  trailing,
}: {
  tabs: ReadonlyArray<UnderlineTab<Value>>;
  value: Value;
  onValueChange: (value: Value) => void;
  className?: string;
  "aria-label"?: string;
  /** Content aligned to the end of the tab row, such as filters. */
  trailing?: React.ReactNode;
}) {
  const move = (event: React.KeyboardEvent<HTMLButtonElement>, index: number) => {
    const offset =
      event.key === "ArrowRight"
        ? 1
        : event.key === "ArrowLeft"
          ? -1
          : event.key === "Home"
            ? -index
            : event.key === "End"
              ? tabs.length - 1 - index
              : 0;
    if (offset === 0) return;
    event.preventDefault();
    const next = tabs[(index + offset + tabs.length) % tabs.length];
    if (!next) return;
    onValueChange(next.value);
    const list = event.currentTarget.parentElement;
    list?.querySelector<HTMLButtonElement>(`[data-tab-value="${next.value}"]`)?.focus();
  };
  return (
    <div
      className={cn(
        "flex flex-wrap items-end justify-between gap-x-3 gap-y-2 border-b border-border",
        className,
      )}
      data-slot="underline-tabs"
    >
      <div className="flex items-center gap-1" role="tablist" aria-label={ariaLabel}>
        {tabs.map((tab, index) => {
          const selected = tab.value === value;
          return (
            <button
              key={tab.value}
              type="button"
              role="tab"
              aria-selected={selected}
              tabIndex={selected ? 0 : -1}
              data-tab-value={tab.value}
              className={cn(
                "-mb-px inline-flex items-center gap-1.5 border-b-2 px-3 py-2 text-sm font-medium transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
                selected
                  ? "border-primary text-foreground"
                  : "border-transparent text-muted-foreground hover:text-foreground",
              )}
              onClick={() => onValueChange(tab.value)}
              onKeyDown={(event) => move(event, index)}
            >
              {tab.label}
              {tab.adornment}
            </button>
          );
        })}
      </div>
      {trailing ? <div className="flex flex-wrap items-center gap-2 pb-1.5">{trailing}</div> : null}
    </div>
  );
}

export { UnderlineTabs };
