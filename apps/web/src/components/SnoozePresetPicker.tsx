import { SNOOZE_PRESETS, resolveSnoozePreset } from "../lib/snoozePresets";
import { cn } from "../lib/utils";

export function SnoozePresetPicker({
  value,
  onChange,
}: {
  readonly value: string;
  readonly onChange: (value: string) => void;
}) {
  const localValue = (() => {
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) return "";
    const offset = date.getTimezoneOffset() * 60_000;
    return new Date(date.getTime() - offset).toISOString().slice(0, 16);
  })();

  return (
    <div className="space-y-2">
      <div className="grid grid-cols-3 gap-2">
        {SNOOZE_PRESETS.map((preset) => (
          <button
            key={preset.id}
            type="button"
            className={cn(
              "rounded-lg border border-input bg-background px-2 py-1.5 text-xs transition-colors hover:bg-accent",
            )}
            onClick={() => onChange(resolveSnoozePreset(preset.id))}
          >
            {preset.label}
          </button>
        ))}
      </div>
      <label className="block space-y-1 text-xs text-muted-foreground">
        <span>Custom</span>
        <input
          className="h-8 w-full rounded-lg border border-input bg-background px-3 text-sm text-foreground"
          type="datetime-local"
          value={localValue}
          min={new Date().toISOString().slice(0, 16)}
          onChange={(event) => {
            const date = new Date(event.currentTarget.value);
            if (Number.isFinite(date.getTime())) onChange(date.toISOString());
          }}
        />
      </label>
    </div>
  );
}
