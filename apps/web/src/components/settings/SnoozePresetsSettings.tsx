import { PlusIcon, XIcon } from "lucide-react";
import { useState } from "react";

import { updateAppSettings, useAppSettingsSelector } from "../../appSettings";
import { useNowMinute } from "../../lib/nowTicker";
import {
  DEFAULT_SNOOZE_PRESETS,
  MAX_SNOOZE_PRESET_MINUTES,
  MAX_SNOOZE_PRESETS,
  SNOOZE_PRESET_DAYS,
  resolveSnoozePreset,
  resolveSnoozePresets,
  snoozePresetId,
  type SnoozePresetDay,
  type SnoozePresetSetting,
} from "../../lib/snoozePresets";
import { formatTimeOfDay } from "../../timestampFormat";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { SettingsCard } from "./SettingsCard";

const UNIT_MINUTES = { minutes: 1, hours: 60, days: 24 * 60 } as const;
type DurationUnit = keyof typeof UNIT_MINUTES;
const DURATION_UNITS = Object.keys(UNIT_MINUTES) as DurationUnit[];

const WHEN_LABELS: Record<"after" | SnoozePresetDay, string> = {
  after: "In",
  today: "Today",
  tomorrow: "Tomorrow",
  "next-week": "In a week",
  monday: "Monday",
  tuesday: "Tuesday",
  wednesday: "Wednesday",
  thursday: "Thursday",
  friday: "Friday",
  saturday: "Saturday",
  sunday: "Sunday",
};
const WHEN_VALUES = ["after", ...SNOOZE_PRESET_DAYS] as const;
const isWhenValue = (value: unknown): value is (typeof WHEN_VALUES)[number] =>
  typeof value === "string" && value in WHEN_LABELS;

// Offered in order when adding, skipping any already in the list.
const ADD_CANDIDATES: ReadonlyArray<SnoozePresetSetting> = [
  ...DEFAULT_SNOOZE_PRESETS,
  { kind: "after", minutes: 60 },
  { kind: "at", day: "today", time: "18:00" },
  { kind: "at", day: "monday", time: "09:00" },
  { kind: "after", minutes: 30 },
  { kind: "at", day: "saturday", time: "09:00" },
  { kind: "after", minutes: 24 * 60 },
];

function nextCandidate(presets: ReadonlyArray<SnoozePresetSetting>): SnoozePresetSetting {
  const used = new Set(presets.map(snoozePresetId));
  return (
    ADD_CANDIDATES.find((candidate) => !used.has(snoozePresetId(candidate))) ?? {
      kind: "after",
      minutes: 60,
    }
  );
}

function splitMinutes(minutes: number): { amount: number; unit: DurationUnit } {
  if (minutes % UNIT_MINUTES.days === 0)
    return { amount: minutes / UNIT_MINUTES.days, unit: "days" };
  if (minutes % UNIT_MINUTES.hours === 0) {
    return { amount: minutes / UNIT_MINUTES.hours, unit: "hours" };
  }
  return { amount: minutes, unit: "minutes" };
}

function unitLabel(unit: DurationUnit, amount: number): string {
  return amount === 1 ? unit.slice(0, -1) : unit;
}

/** Edits every snooze menu's options. Menus sort them by wake time; rows keep their order. */
export function SnoozePresetsSettings() {
  const presets = useAppSettingsSelector((settings) => settings.snoozePresets);
  const timestampFormat = useAppSettingsSelector((settings) => settings.timestampFormat);
  // Row keys survive removals, so a row's half-typed amount stays with that row.
  const [rowKeys, setRowKeys] = useState<{ keys: number[]; next: number }>(() => ({
    keys: presets.map((_, index) => index),
    next: presets.length,
  }));
  const keys =
    rowKeys.keys.length === presets.length
      ? rowKeys.keys
      : presets.map((_, index) => rowKeys.next + index);
  const save = (snoozePresets: ReadonlyArray<SnoozePresetSetting>, nextKeys: number[]) => {
    setRowKeys({ keys: nextKeys, next: Math.max(rowKeys.next, ...nextKeys, -1) + 1 });
    updateAppSettings({ snoozePresets });
  };
  const changed = JSON.stringify(presets) !== JSON.stringify(DEFAULT_SNOOZE_PRESETS);

  const now = new Date(useNowMinute());
  const formatTime = (date: Date) => formatTimeOfDay(date, timestampFormat);
  const seenIds = new Set<string>();
  const seenWakes = new Set<string>();
  const previews = presets.map((preset) => {
    const resolved = resolveSnoozePreset(preset, now, formatTime);
    if (resolved === null) return { text: "Passed for today" };
    if (seenIds.has(resolved.id)) return { text: "Duplicate of an option above" };
    if (seenWakes.has(resolved.snoozedUntil)) return { text: "Same time as an option above" };
    seenIds.add(resolved.id);
    seenWakes.add(resolved.snoozedUntil);
    return { label: resolved.label, when: resolved.whenLabel };
  });
  const menu = resolveSnoozePresets(presets, now, formatTime);

  return (
    <SettingsCard
      title="Snooze options"
      description="Choices in every snooze menu, listed soonest first. A weekday means the next one after today."
      searchTarget="threads.snooze-options"
      actions={
        changed ? (
          <Button
            size="xs"
            variant="outline"
            onClick={() =>
              save(
                DEFAULT_SNOOZE_PRESETS,
                DEFAULT_SNOOZE_PRESETS.map((_, index) => rowKeys.next + index),
              )
            }
          >
            Restore defaults
          </Button>
        ) : null
      }
    >
      <div className="flex flex-col gap-1.5">
        {presets.map((preset, index) => {
          const preview = previews[index]!;
          return (
            <div
              key={keys[index]}
              role="group"
              aria-label={`Snooze option ${index + 1}`}
              className="flex flex-wrap items-center gap-2"
            >
              <SnoozePresetFields
                preset={preset}
                onChange={(next) =>
                  save(
                    presets.map((candidate, position) => (position === index ? next : candidate)),
                    keys,
                  )
                }
              />
              <div className="ml-auto flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
                {"label" in preview ? (
                  <span className="truncate">
                    <span className="text-foreground">{preview.label}</span>
                    <span className="ps-2 tabular-nums">{preview.when}</span>
                  </span>
                ) : (
                  <span className="truncate">{preview.text}</span>
                )}
                <Button
                  variant="ghost"
                  size="icon-xs"
                  aria-label={`Remove snooze option ${index + 1}`}
                  onClick={() =>
                    save(
                      presets.filter((_, position) => position !== index),
                      keys.filter((_, position) => position !== index),
                    )
                  }
                >
                  <XIcon />
                </Button>
              </div>
            </div>
          );
        })}
        <p className="text-xs text-muted-foreground">
          {menu.length === 0
            ? "Menus offer only a custom time."
            : `Menu now: ${menu.map((preset) => `${preset.label} (${preset.whenLabel})`).join(" · ")}`}
        </p>
        <div className="flex items-center gap-2">
          <Button
            variant="ghost"
            size="xs"
            disabled={presets.length >= MAX_SNOOZE_PRESETS}
            onClick={() =>
              save([...presets, nextCandidate(presets)], [...keys, rowKeys.next + keys.length])
            }
          >
            <PlusIcon />
            Add option
          </Button>
          {presets.length >= MAX_SNOOZE_PRESETS ? (
            <span className="text-xs text-muted-foreground">
              Up to {MAX_SNOOZE_PRESETS} options
            </span>
          ) : null}
        </div>
      </div>
    </SettingsCard>
  );
}

function SnoozePresetFields(props: {
  preset: SnoozePresetSetting;
  onChange: (preset: SnoozePresetSetting) => void;
}) {
  const { preset, onChange } = props;
  const when = preset.kind === "after" ? "after" : preset.day;
  // Switching between a duration and a set time keeps the other kind's last value, so a
  // misclick on "When" can be undone without retyping it.
  const [memory, setMemory] = useState({ minutes: 60, time: "09:00" });
  return (
    <div className="flex items-center gap-2">
      <Select
        value={when}
        onValueChange={(value) => {
          if (!isWhenValue(value) || value === when) return;
          if (preset.kind === "after") setMemory({ ...memory, minutes: preset.minutes });
          else setMemory({ ...memory, time: preset.time });
          onChange(
            value === "after"
              ? {
                  kind: "after",
                  minutes: preset.kind === "after" ? preset.minutes : memory.minutes,
                }
              : { kind: "at", day: value, time: preset.kind === "at" ? preset.time : memory.time },
          );
        }}
      >
        <SelectTrigger size="sm" className="w-32" aria-label="When">
          <SelectValue>{WHEN_LABELS[when]}</SelectValue>
        </SelectTrigger>
        <SelectPopup>
          {WHEN_VALUES.map((value) => (
            <SelectItem key={value} value={value}>
              {WHEN_LABELS[value]}
            </SelectItem>
          ))}
        </SelectPopup>
      </Select>
      {preset.kind === "after" ? (
        <DurationFields
          minutes={preset.minutes}
          onChange={(minutes) => onChange({ kind: "after", minutes })}
        />
      ) : (
        <>
          <span className="text-xs text-muted-foreground">at</span>
          <Input
            size="sm"
            type="time"
            className="w-32"
            aria-label="Time"
            value={preset.time}
            onChange={(event) => {
              if (/^\d{2}:\d{2}$/.test(event.target.value)) {
                onChange({ ...preset, time: event.target.value });
              }
            }}
          />
        </>
      )}
    </div>
  );
}

function DurationFields(props: { minutes: number; onChange: (minutes: number) => void }) {
  // The chosen unit stays put while editing, so 59 → 60 minutes does not jump to hours.
  const [chosenUnit, setChosenUnit] = useState(() => splitMinutes(props.minutes).unit);
  const unit =
    props.minutes % UNIT_MINUTES[chosenUnit] === 0 ? chosenUnit : splitMinutes(props.minutes).unit;
  const amount = props.minutes / UNIT_MINUTES[unit];
  const maxAmount = Math.floor(MAX_SNOOZE_PRESET_MINUTES / UNIT_MINUTES[unit]);
  // Typing stays local until the field commits (blur or Enter), so half-typed values never save.
  const [draft, setDraft] = useState({ source: props.minutes, text: String(amount) });
  if (draft.source !== props.minutes) setDraft({ source: props.minutes, text: String(amount) });
  const commit = () => {
    const parsed = Number(draft.text);
    if (!Number.isFinite(parsed) || draft.text.trim() === "") {
      setDraft({ source: props.minutes, text: String(amount) });
      return;
    }
    const next = Math.min(maxAmount, Math.max(1, Math.round(parsed)));
    setDraft({ source: props.minutes, text: String(next) });
    if (next !== amount) props.onChange(next * UNIT_MINUTES[unit]);
  };
  return (
    <>
      <Input
        size="sm"
        className="w-20"
        inputMode="numeric"
        aria-label="Amount"
        value={draft.text}
        onChange={(event) => setDraft({ ...draft, text: event.target.value })}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === "Enter") commit();
        }}
      />
      <Select
        value={unit}
        onValueChange={(value) => {
          if (value !== "minutes" && value !== "hours" && value !== "days") return;
          setChosenUnit(value);
          props.onChange(Math.min(amount * UNIT_MINUTES[value], MAX_SNOOZE_PRESET_MINUTES));
        }}
      >
        <SelectTrigger size="sm" className="w-28" aria-label="Unit">
          <SelectValue>{unitLabel(unit, amount)}</SelectValue>
        </SelectTrigger>
        <SelectPopup>
          {DURATION_UNITS.map((value) => (
            <SelectItem key={value} value={value}>
              {unitLabel(value, amount)}
            </SelectItem>
          ))}
        </SelectPopup>
      </Select>
    </>
  );
}
