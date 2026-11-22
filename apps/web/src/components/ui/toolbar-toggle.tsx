import type * as React from "react";

import { cn } from "~/lib/utils";
import { Kbd } from "./kbd";
import { Toggle } from "./toggle";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./tooltip";

/**
 * Icon toggle for title bars and toolbars: 28px hit target, 16px icon,
 * tooltip with an optional shortcut, and an optional count badge.
 * The `segmented` variant is a 24px segment for use inside a grouped control;
 * `inBackground` marks something that is open but not currently in front.
 */
function ToolbarToggle({
  icon: Icon,
  label,
  ariaLabel,
  shortcutLabel,
  tooltipDetails,
  pressed,
  onPressedChange,
  disabled = false,
  disabledReason,
  badgeCount,
  variant = "default",
  inBackground = false,
  className,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  ariaLabel?: string | undefined;
  shortcutLabel?: string | null | undefined;
  tooltipDetails?: React.ReactNode;
  pressed: boolean;
  onPressedChange: (pressed: boolean) => void;
  disabled?: boolean | undefined;
  disabledReason?: string | undefined;
  badgeCount?: number | undefined;
  variant?: "default" | "segmented" | undefined;
  inBackground?: boolean | undefined;
  className?: string | undefined;
}) {
  const tooltip =
    disabled && disabledReason
      ? disabledReason
      : inBackground
        ? `${label} · open in background`
        : label;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Toggle
            size="sm"
            pressed={pressed}
            onPressedChange={onPressedChange}
            disabled={disabled}
            aria-label={`${ariaLabel ?? label}${inBackground ? ", open in background" : ""}`}
            data-in-background={inBackground ? "" : undefined}
            className={cn(
              "relative shrink-0 px-0 text-muted-foreground hover:text-foreground data-pressed:text-foreground",
              variant === "segmented"
                ? "size-6 min-w-6 rounded-md data-pressed:bg-accent data-pressed:shadow-xs data-pressed:ring-1 data-pressed:ring-foreground/8 sm:size-6 sm:min-w-6"
                : "size-7 min-w-7 rounded-md data-pressed:bg-accent sm:size-7 sm:min-w-7",
              className,
            )}
          >
            <Icon className="size-4" />
            {inBackground ? (
              <span
                aria-hidden="true"
                className={cn(
                  "absolute left-1/2 size-1 -translate-x-1/2 rounded-full bg-muted-foreground",
                  variant === "segmented" ? "bottom-0" : "bottom-0.5",
                )}
              />
            ) : null}
            {badgeCount && badgeCount > 0 ? (
              <span
                aria-hidden="true"
                className="absolute -top-1 -right-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-info px-1 text-2xs leading-none font-semibold text-white tabular-nums"
              >
                {badgeCount}
              </span>
            ) : null}
          </Toggle>
        }
      />
      <TooltipPopup side="bottom">
        <div className="flex items-center gap-2">
          {tooltip}
          {shortcutLabel && !disabled ? <Kbd>{shortcutLabel}</Kbd> : null}
        </div>
        {!disabled && tooltipDetails ? <div className="mt-1.5">{tooltipDetails}</div> : null}
      </TooltipPopup>
    </Tooltip>
  );
}

export { ToolbarToggle };
