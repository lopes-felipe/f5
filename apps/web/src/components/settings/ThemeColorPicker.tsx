import { useEffect, useId, useState } from "react";

import {
  applyPickedThemeColor,
  parseSafeThemeColor,
  themeColorToPickerHex,
} from "../../themePalette";
import { Input } from "../ui/input";

export function ThemeColorPicker({
  label,
  value,
  onChange,
}: {
  readonly label: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
}) {
  const inputId = useId();
  const [draft, setDraft] = useState(value);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => setDraft(value), [value]);

  const commit = () => {
    try {
      const next = parseSafeThemeColor(draft);
      setDraft(next);
      setError(null);
      onChange(next);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const pick = (picked: string) => {
    try {
      const next = applyPickedThemeColor(picked, value);
      setDraft(next);
      setError(null);
      onChange(next);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const pickerValue = themeColorToPickerHex(error ? value : draft) ?? "#000000";

  return (
    <div className="space-y-1.5">
      <label htmlFor={inputId} className="block text-xs font-medium text-foreground">
        {label}
      </label>
      <span className="flex items-center gap-2">
        <span
          className="relative size-7 shrink-0 cursor-pointer rounded-md border border-border has-focus-visible:ring-2 has-focus-visible:ring-ring"
          style={{ backgroundColor: error ? "transparent" : draft }}
        >
          <input
            type="color"
            aria-label={`Pick ${label} color`}
            title={`Pick ${label} color`}
            className="absolute inset-0 size-full cursor-pointer opacity-0"
            value={pickerValue}
            onChange={(event) => pick(event.target.value)}
          />
        </span>
        <Input
          id={inputId}
          nativeInput
          value={draft}
          aria-invalid={error ? true : undefined}
          onChange={(event) => {
            setDraft(event.target.value);
            setError(null);
          }}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              event.currentTarget.blur();
            }
          }}
        />
      </span>
      {error ? <span className="block text-xs text-destructive-foreground">{error}</span> : null}
    </div>
  );
}
