import { useAppSettingsSelector } from "../appSettings";
import { pickSnoozePreset, resolveSnoozePresets } from "../lib/snoozePresets";
import { cn } from "../lib/utils";
import { formatTimeOfDay } from "../timestampFormat";

export function SnoozePresetPicker({
  value,
  onChange,
}: {
  readonly value: string;
  readonly onChange: (value: string) => void;
}) {
  const presets = useAppSettingsSelector((settings) => settings.snoozePresets);
  const timestampFormat = useAppSettingsSelector((settings) => settings.timestampFormat);
  const formatTime = (date: Date) => formatTimeOfDay(date, timestampFormat);
  const localValue = (() => {
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) return "";
    const offset = date.getTimezoneOffset() * 60_000;
    return new Date(date.getTime() - offset).toISOString().slice(0, 16);
  })();
  const now = new Date();
  const localMinimum = new Date(now.getTime() - now.getTimezoneOffset() * 60_000)
    .toISOString()
    .slice(0, 16);
  const shown = resolveSnoozePresets(presets, now, formatTime);

  return (
    <div className="space-y-2">
      {shown.length > 0 ? (
        <div className="grid grid-cols-3 gap-2">
          {shown.map((preset) => (
            <button
              key={preset.id}
              type="button"
              title={preset.whenLabel}
              className={cn(
                "rounded-lg border border-input bg-background px-2 py-1.5 text-xs transition-colors hover:bg-accent",
              )}
              onClick={() => {
                const picked = pickSnoozePreset({ shown, id: preset.id, presets });
                if (picked) onChange(picked.snoozedUntil);
              }}
            >
              {preset.label}
            </button>
          ))}
        </div>
      ) : null}
      <label className="block space-y-1 text-xs text-muted-foreground">
        <span>Custom</span>
        <input
          className="h-8 w-full rounded-lg border border-input bg-background px-3 text-sm text-foreground"
          type="datetime-local"
          value={localValue}
          min={localMinimum}
          onChange={(event) => {
            const date = new Date(event.currentTarget.value);
            if (Number.isFinite(date.getTime())) onChange(date.toISOString());
          }}
        />
      </label>
    </div>
  );
}
