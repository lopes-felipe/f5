"use client";

import { useEffect, useState } from "react";

import { cn } from "../../lib/utils";
import { normalizeProviderAccentColor, PROVIDER_ACCENT_SWATCHES } from "../../providerInstances";
import { Button } from "../ui/button";

export interface AccentColorPickerProps {
  /** Accessible name for the native color input, e.g. `Accent color for Work`. */
  readonly ariaLabel: string;
  /** Visible field label. Defaults to "Accent color". Pass `null` to omit. */
  readonly label?: string | null;
  /** Helper text rendered under the swatches. */
  readonly description?: string;
  /** Current committed value, or undefined when unset. */
  readonly value: string | undefined;
  /** Fires on blur of the native input and on swatch click. `""` means "cleared". */
  readonly onCommit: (value: string) => void;
  /**
   * Show the Clear button. Defaults to `true`. Profiles pass `false` because
   * `ProfileRegistryStore.update` skips `accentColor: undefined`, so there is
   * no representable "unset" value on that contract.
   */
  readonly allowClear?: boolean;
  readonly disabled?: boolean;
  readonly className?: string;
}

/**
 * Accent color field: a native color input paired with the shared swatch
 * palette. Buffers the draft locally and commits on blur (or immediately on a
 * swatch click) so a server-hydrated value never clobbers an in-progress edit.
 */
export function AccentColorPicker({
  ariaLabel,
  label = "Accent color",
  description,
  value,
  onCommit,
  allowClear = true,
  disabled = false,
  className,
}: AccentColorPickerProps) {
  const [draft, setDraft] = useState(value ?? "");
  const [isEditing, setIsEditing] = useState(false);
  const draftColor = normalizeProviderAccentColor(draft);

  useEffect(() => {
    if (isEditing) return;
    setDraft(value ?? "");
  }, [isEditing, value]);

  const commitDraft = () => {
    setIsEditing(false);
    onCommit(draftColor ?? "");
  };

  const commitSwatch = (swatch: string) => {
    setIsEditing(false);
    setDraft(swatch);
    onCommit(swatch);
  };

  return (
    <div className={cn("grid gap-2", className)}>
      {label === null ? null : <span className="text-xs font-medium text-foreground">{label}</span>}
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <input
          type="color"
          value={draftColor ?? PROVIDER_ACCENT_SWATCHES[0]}
          disabled={disabled}
          onFocus={() => setIsEditing(true)}
          onInput={(event) => {
            setIsEditing(true);
            setDraft(event.currentTarget.value);
          }}
          onChange={(event) => {
            setIsEditing(true);
            setDraft(event.currentTarget.value);
          }}
          onBlur={commitDraft}
          aria-label={ariaLabel}
          className="h-8 w-10 cursor-pointer rounded border border-input bg-background p-0.5 disabled:cursor-not-allowed disabled:opacity-50"
        />
        <div className="flex flex-wrap gap-1.5">
          {PROVIDER_ACCENT_SWATCHES.map((swatch) => {
            const selected = draftColor?.toLowerCase() === swatch;
            return (
              <button
                key={swatch}
                type="button"
                disabled={disabled}
                className={cn(
                  "size-6 cursor-pointer rounded-full border transition disabled:cursor-not-allowed disabled:opacity-50",
                  selected
                    ? "border-foreground ring-2 ring-ring ring-offset-1 ring-offset-background"
                    : "border-black/10 hover:scale-105 dark:border-white/20",
                )}
                style={{ backgroundColor: swatch }}
                onClick={() => commitSwatch(swatch)}
                aria-label={`Use ${swatch} accent`}
              />
            );
          })}
        </div>
        {allowClear && draftColor ? (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={disabled}
            className="h-7 px-2 text-xs text-muted-foreground"
            onClick={() => {
              setIsEditing(false);
              setDraft("");
              onCommit("");
            }}
          >
            Clear
          </Button>
        ) : null}
      </div>
      {description ? <span className="text-xs text-muted-foreground">{description}</span> : null}
    </div>
  );
}
