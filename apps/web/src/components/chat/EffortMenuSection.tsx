import { ZapIcon } from "lucide-react";

import { cn } from "~/lib/utils";
import { MenuGroup, MenuRadioGroup, MenuRadioItem } from "../ui/menu";
import { getEffortLevel, sortEffortOptions } from "./effortLevels";
import { useLadderPreview } from "./useLadderPreview";

export interface EffortMenuOption {
  readonly id: string;
  readonly label: string;
  readonly isDefault?: boolean | undefined;
}

/** Row content for a Fast mode switch: the zap lights up amber while it's on. */
export function FastModeLabel(props: { enabled: boolean; label?: string }) {
  return (
    <span className="flex items-center gap-2">
      <ZapIcon
        aria-hidden="true"
        className={cn(
          "size-3.5",
          props.enabled ? "fill-warning text-warning" : "text-muted-foreground",
        )}
      />
      {props.label ?? "Fast Mode"}
    </span>
  );
}

/** Amber zap shown in a traits trigger chip while Fast mode is on. */
export function FastModeTriggerIcon() {
  return (
    <ZapIcon aria-label="Fast mode enabled" className="size-3 shrink-0 fill-warning text-warning" />
  );
}

/**
 * Reasoning effort as a ranked "battery": highest level at the top, one
 * coloured segment per row, filled from the lowest level up to the selected
 * one. Highlighting a row (pointer or keyboard) previews its fill.
 *
 * In forced-colours mode the level colours become system colours: filled
 * segments use CanvasText, empty ones GrayText, and the selected one Highlight.
 */
export function EffortMenuSection(props: {
  options: ReadonlyArray<EffortMenuOption>;
  value: string | null;
  onValueChange: (value: string) => void;
}) {
  const { previewValue: previewLevel, groupProps } = useLadderPreview("effortLevel");

  const options = sortEffortOptions(props.options);
  const selectedIndex = options.findIndex((option) => option.id === props.value);
  const previewIndex = options.findIndex((option) => option.id === previewLevel);
  // Rows are top-down, so a row is filled when it sits at or below the fill line.
  const fillIndex = previewIndex >= 0 ? previewIndex : selectedIndex;

  return (
    <MenuGroup {...groupProps}>
      <div className="px-2 py-1.5 font-medium text-muted-foreground text-xs">Reasoning effort</div>
      <MenuRadioGroup
        value={props.value ?? ""}
        onValueChange={(value: unknown) => {
          if (typeof value === "string" && value) props.onValueChange(value);
        }}
      >
        {options.map((option, index) => {
          const level = getEffortLevel(option.id);
          const selected = index === selectedIndex;
          const filled = fillIndex >= 0 && index >= fillIndex;
          return (
            <MenuRadioItem
              key={option.id}
              variant="plain"
              value={option.id}
              aria-label={`${option.label}${option.isDefault ? " (default)" : ""}`}
              data-effort-level={option.id}
              className="gap-2.5 py-0.5 ps-1.5 pe-2"
            >
              <span
                aria-hidden="true"
                data-effort-filled={filled}
                data-effort-selected={selected}
                className={cn(
                  "h-6 w-3.5 shrink-0 rounded-xs transition-[background-color,box-shadow] duration-150",
                  index === 0 && "rounded-t-md",
                  index === options.length - 1 && "rounded-b-md",
                  filled
                    ? level?.segmentClass
                    : "bg-foreground/10 forced-colors:bg-[color:GrayText]",
                  selected && [level?.glowClass, "forced-colors:bg-[color:Highlight]"],
                )}
              />
              <span
                className={cn("flex-1 truncate", selected && ["font-semibold", level?.textClass])}
              >
                {option.label}
              </span>
              {level ? (
                <span aria-hidden="true" className="ms-4 shrink-0 text-muted-foreground text-xs">
                  {option.isDefault ? `Default · ${level.tag}` : level.tag}
                </span>
              ) : null}
            </MenuRadioItem>
          );
        })}
      </MenuRadioGroup>
    </MenuGroup>
  );
}
