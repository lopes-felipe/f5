import type { ProviderKind, RuntimeMode } from "@t3tools/contracts";
import {
  RUNTIME_MODES_BY_AUTONOMY,
  runtimeModeCapabilities,
  runtimeModeUnsupportedReason,
} from "@t3tools/shared/runtimeMode";

import { cn } from "~/lib/utils";

import { Button } from "../ui/button";
import { COMPOSER_CHIP_CLASS_NAME } from "./composer/composerChip";
import { Menu, MenuGroup, MenuPopup, MenuRadioGroup, MenuRadioItem, MenuTrigger } from "../ui/menu";
import { RUNTIME_MODE_PRESENTATION } from "./runtimeModePresentation";
import { useLadderPreview } from "./useLadderPreview";

/** Ladder rows, top-down: most autonomous first, like the reasoning effort battery. */
const LADDER_MODES: ReadonlyArray<RuntimeMode> = RUNTIME_MODES_BY_AUTONOMY.toReversed();

/**
 * Access modes as an "autonomy ladder": one coloured segment per row, filled from the least
 * autonomous mode up to the selected one. Highlighting a row previews its fill. Modes the
 * provider doesn't support stay visible (disabled, never filled) so the scale keeps its shape.
 *
 * In forced-colours mode filled segments use CanvasText, empty ones GrayText, and the selected
 * one Highlight.
 */
export function RuntimeModeMenuItems(props: {
  readonly disabled?: boolean | undefined;
  readonly provider: ProviderKind;
  /** The selected instance's own support, when its snapshot narrows the per-driver default. */
  readonly availableRuntimeModes?: ReadonlyArray<RuntimeMode> | undefined;
  readonly value: RuntimeMode;
  readonly onValueChange: (value: RuntimeMode) => void;
}) {
  const capabilities = runtimeModeCapabilities(props.provider, props.availableRuntimeModes);
  const { previewValue, groupProps } = useLadderPreview("runtimeMode");
  const previewMode = LADDER_MODES.find((mode) => mode === previewValue && capabilities.has(mode));
  // A segment is filled when its mode is no more autonomous than the fill line.
  const fillRank = RUNTIME_MODES_BY_AUTONOMY.indexOf(previewMode ?? props.value);
  return (
    <MenuRadioGroup
      {...groupProps}
      value={props.value}
      onValueChange={(value) => {
        if (!value || props.disabled || value === props.value) return;
        const runtimeMode = value as RuntimeMode;
        if (!capabilities.has(runtimeMode)) return;
        props.onValueChange(runtimeMode);
      }}
    >
      {LADDER_MODES.map((runtimeMode, index) => {
        const presentation = RUNTIME_MODE_PRESENTATION[runtimeMode];
        const Icon = presentation.icon;
        const unsupportedReason = runtimeModeUnsupportedReason(
          props.provider,
          runtimeMode,
          props.availableRuntimeModes,
        );
        const supported = unsupportedReason === undefined;
        const selected = runtimeMode === props.value;
        const filled = supported && RUNTIME_MODES_BY_AUTONOMY.indexOf(runtimeMode) <= fillRank;
        return (
          <MenuRadioItem
            key={runtimeMode}
            variant="plain"
            value={runtimeMode}
            disabled={props.disabled || !supported}
            title={unsupportedReason ?? presentation.description}
            data-runtime-mode={runtimeMode}
            className="gap-2.5 py-0.5 ps-1.5 pe-2"
          >
            <span
              aria-hidden="true"
              data-ladder-filled={filled}
              data-ladder-selected={selected}
              className={cn(
                "h-6 w-3.5 shrink-0 rounded-xs transition-[background-color,box-shadow] duration-150",
                index === 0 && "rounded-t-md",
                index === LADDER_MODES.length - 1 && "rounded-b-md",
                filled
                  ? [presentation.segmentClass, "forced-colors:bg-[color:CanvasText]"]
                  : "bg-foreground/10 forced-colors:bg-[color:GrayText]",
                selected && [presentation.glowClass, "forced-colors:bg-[color:Highlight]"],
              )}
            />
            <Icon
              aria-hidden="true"
              className={cn("size-4 shrink-0", selected ? presentation.textClass : "opacity-80")}
            />
            <span
              className={cn(
                "flex-1 truncate",
                selected && ["font-semibold", presentation.textClass],
              )}
            >
              {presentation.label}
            </span>
            <span className="ms-4 shrink-0 text-muted-foreground text-xs">
              {supported ? presentation.tag : "Unavailable"}
            </span>
          </MenuRadioItem>
        );
      })}
    </MenuRadioGroup>
  );
}

export function RuntimeModePicker(props: {
  readonly disabled?: boolean | undefined;
  readonly provider: ProviderKind;
  readonly availableRuntimeModes?: ReadonlyArray<RuntimeMode> | undefined;
  readonly value: RuntimeMode;
  readonly onValueChange: (value: RuntimeMode) => void;
}) {
  const presentation = RUNTIME_MODE_PRESENTATION[props.value];
  const Icon = presentation.icon;
  return (
    <Menu>
      <MenuTrigger
        data-composer-control="runtimeMode"
        render={
          <Button
            variant="ghost"
            className={cn(
              COMPOSER_CHIP_CLASS_NAME,
              props.value === "full-access" &&
                "text-warning-foreground hover:text-warning-foreground data-popup-open:text-warning-foreground",
            )}
            size="sm"
            type="button"
            disabled={props.disabled}
            title={`${presentation.label} — ${presentation.description}`}
          />
        }
      >
        <Icon />
        <span className="sr-only @lg/composer-footer:not-sr-only">{presentation.label}</span>
      </MenuTrigger>
      <MenuPopup align="end" side="top">
        <MenuGroup>
          <div className="px-2 py-1.5 font-medium text-muted-foreground text-xs">Access</div>
          <RuntimeModeMenuItems {...props} />
        </MenuGroup>
      </MenuPopup>
    </Menu>
  );
}
