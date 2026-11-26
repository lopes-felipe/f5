import type { ProviderKind, RuntimeMode } from "@t3tools/contracts";
import {
  RUNTIME_MODES_BY_AUTONOMY,
  runtimeModeCapabilities,
  runtimeModeUnsupportedReason,
  supportedRuntimeModeAtOrBelow,
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
 * autonomous mode up to the selected one. Highlighting a row previews its fill, and a caption
 * under the rows describes that mode. Modes the provider doesn't support stay visible (disabled,
 * never filled) so the scale keeps its shape, and the caption says why.
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
  // A saved mode the provider no longer offers (resumed Antigravity Auto) fills only up to the
  // most autonomous supported mode below it.
  const effectiveMode = capabilities.has(props.value)
    ? props.value
    : supportedRuntimeModeAtOrBelow(capabilities, props.value);
  // Opening from the keyboard lands on the current mode, never on the Full access edge row.
  const initialFocusMode =
    effectiveMode ?? RUNTIME_MODES_BY_AUTONOMY.find((mode) => capabilities.has(mode));
  const { previewValue, groupProps } = useLadderPreview(
    "runtimeMode",
    initialFocusMode ? { initialFocusValue: initialFocusMode } : undefined,
  );
  const previewMode = LADDER_MODES.find((mode) => mode === previewValue && capabilities.has(mode));
  const fillMode = previewMode ?? effectiveMode;
  // A segment is filled when its mode is no more autonomous than the fill line.
  const fillRank = fillMode ? RUNTIME_MODES_BY_AUTONOMY.indexOf(fillMode) : -1;
  const unsupportedReasons = LADDER_MODES.flatMap((mode) => {
    const reason = runtimeModeUnsupportedReason(props.provider, mode, props.availableRuntimeModes);
    return reason ? [reason] : [];
  });
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
        // The glow and forced-colours Highlight only mark a filled segment.
        const selectedSegment = selected && filled;
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
              data-ladder-selected={selectedSegment}
              className={cn(
                "h-6 w-3.5 shrink-0 rounded-xs transition-[background-color,box-shadow] duration-150",
                index === 0 && "rounded-t-md",
                index === LADDER_MODES.length - 1 && "rounded-b-md",
                filled
                  ? [presentation.segmentClass, "forced-colors:bg-[color:CanvasText]"]
                  : "bg-foreground/10 forced-colors:bg-[color:GrayText]",
                selectedSegment && [presentation.glowClass, "forced-colors:bg-[color:Highlight]"],
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
              {supported ? presentation.tag : selected ? "Current · unavailable" : "Unavailable"}
            </span>
          </MenuRadioItem>
        );
      })}
      {/* Tooltips never show on disabled rows or touch, so the details stay visible here.
          `w-0 min-w-full` wraps the text at the rows' width instead of widening the popup. */}
      <div
        aria-hidden="true"
        data-ladder-caption=""
        className="w-0 min-w-full space-y-1 px-2 pt-1.5 pb-1 text-muted-foreground text-xs"
      >
        {/* Every description shares one grid cell, so the caption keeps the height of the longest.
            The menu opens upwards: a caption that resized with the preview would shift the rows
            under the pointer and flicker the highlight between two rows. */}
        <div className="grid">
          {LADDER_MODES.map((mode) => {
            const shown = mode === (previewMode ?? props.value);
            return (
              <p key={mode} className={cn("col-start-1 row-start-1", !shown && "invisible")}>
                {RUNTIME_MODE_PRESENTATION[mode].description}
              </p>
            );
          })}
        </div>
        {unsupportedReasons.map((reason) => (
          <p key={reason}>{reason}</p>
        ))}
      </div>
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
