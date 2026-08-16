import { useEffect, useState } from "react";

import { parseSafeThemeColor } from "../../themePalette";
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

  return (
    <label className="block space-y-1.5">
      <span className="text-xs font-medium text-foreground">{label}</span>
      <span className="flex items-center gap-2">
        <span
          className="size-7 shrink-0 rounded-md border border-border"
          style={{ backgroundColor: error ? "transparent" : draft }}
          aria-hidden="true"
        />
        <Input
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
    </label>
  );
}
