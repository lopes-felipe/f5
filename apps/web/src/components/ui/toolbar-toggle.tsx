import type * as React from "react";

import { cn } from "~/lib/utils";
import { Kbd } from "./kbd";
import { Toggle } from "./toggle";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./tooltip";

/**
 * Icon toggle for title bars and toolbars: 28px hit target, 16px icon,
 * tooltip with an optional shortcut, and an optional count badge.
 */
function ToolbarToggle({
  icon: Icon,
  label,
  ariaLabel,
  shortcutLabel,
  pressed,
  onPressedChange,
  disabled = false,
  disabledReason,
  badgeCount,
  className,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  ariaLabel?: string | undefined;
  shortcutLabel?: string | null | undefined;
  pressed: boolean;
  onPressedChange: (pressed: boolean) => void;
  disabled?: boolean | undefined;
  disabledReason?: string | undefined;
  badgeCount?: number | undefined;
  className?: string | undefined;
}) {
  const tooltip = disabled && disabledReason ? disabledReason : label;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Toggle
            size="sm"
            pressed={pressed}
            onPressedChange={onPressedChange}
            disabled={disabled}
            aria-label={ariaLabel ?? label}
            className={cn(
              "relative size-7 min-w-7 shrink-0 rounded-md px-0 text-muted-foreground hover:text-foreground data-pressed:bg-accent data-pressed:text-foreground sm:size-7 sm:min-w-7",
              className,
            )}
          >
            <Icon className="size-4" />
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
      <TooltipPopup side="bottom" className="flex items-center gap-2">
        {tooltip}
        {shortcutLabel && !disabled ? <Kbd>{shortcutLabel}</Kbd> : null}
      </TooltipPopup>
    </Tooltip>
  );
}

export { ToolbarToggle };
