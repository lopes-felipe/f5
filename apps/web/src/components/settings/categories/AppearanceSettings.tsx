import { useEffect, useId, useRef, useState } from "react";

import {
  CHAT_FONT_SIZE_MAX,
  CHAT_FONT_SIZE_MIN,
  CURATED_MONO_FONT_FAMILIES,
  CURATED_UI_FONT_FAMILIES,
  DEFAULT_MONO_FONT_STACK,
  DEFAULT_UI_FONT_STACK,
  TERMINAL_FONT_SIZE_MAX,
  TERMINAL_FONT_SIZE_MIN,
  UI_FONT_SIZE_MAX,
  UI_FONT_SIZE_MIN,
  fontFamilyStack,
  parseFontFamilyPreference,
} from "../../../appearanceSettings";
import { buildAppSettingsPatch } from "../../../appSettings";
import { Button } from "../../ui/button";
import { Input } from "../../ui/input";
import { useSettingsRouteContext } from "../SettingsRouteContext";

export { APPEARANCE_SETTINGS_DESCRIPTORS } from "./AppearanceSettings.descriptors";

const THEME_OPTIONS = [
  {
    value: "system",
    label: "System",
    description: "Match your OS appearance setting.",
  },
  {
    value: "light",
    label: "Light",
    description: "Always use the light theme.",
  },
  {
    value: "dark",
    label: "Dark",
    description: "Always use the dark theme.",
  },
] as const;

interface FontFamilyFieldProps {
  readonly label: string;
  readonly description: string;
  readonly ariaLabel: string;
  readonly value: string;
  readonly curatedFamilies: readonly string[];
  readonly fallbackStack: string;
  readonly onChange: (value: string) => void;
}

function FontFamilyField({
  label,
  description,
  ariaLabel,
  value,
  curatedFamilies,
  fallbackStack,
  onChange,
}: FontFamilyFieldProps) {
  const datalistId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [draft, setDraft] = useState(value);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (document.activeElement !== inputRef.current) {
      setDraft(value);
      setError(null);
    }
  }, [value]);

  const commit = () => {
    const parsed = parseFontFamilyPreference(draft);
    if (!parsed.valid) {
      setError(parsed.message);
      return;
    }
    setDraft(parsed.value);
    setError(null);
    onChange(parsed.value);
  };
  const previewValue = parseFontFamilyPreference(draft);
  const previewFamily = fontFamilyStack(
    previewValue.valid ? previewValue.value : value,
    fallbackStack,
  );

  return (
    <div className="rounded-lg border border-border bg-background px-3 py-3">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-foreground">{label}</p>
          <p className="text-xs text-muted-foreground">{description}</p>
          <p
            className="mt-2 truncate text-base text-foreground"
            style={{ fontFamily: previewFamily }}
          >
            The quick brown fox jumps over the lazy dog.
          </p>
        </div>
        <div className="w-full shrink-0 sm:w-64">
          <Input
            ref={inputRef}
            nativeInput
            aria-label={ariaLabel}
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? `${datalistId}-error` : undefined}
            list={datalistId}
            placeholder="System default"
            value={draft}
            onChange={(event) => {
              setDraft(event.target.value);
              setError(null);
            }}
            onBlur={commit}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                inputRef.current?.blur();
              } else if (event.key === "Escape") {
                setDraft(value);
                setError(null);
                inputRef.current?.blur();
              }
            }}
          />
          <datalist id={datalistId}>
            {curatedFamilies.map((family) => (
              <option key={family} value={family} />
            ))}
          </datalist>
          {error ? (
            <p id={`${datalistId}-error`} className="mt-1 text-xs text-destructive-foreground">
              {error}
            </p>
          ) : (
            <p className="mt-1 text-xs text-muted-foreground">
              Choose a suggestion or enter up to four fallback families.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

interface FontSizeFieldProps {
  readonly label: string;
  readonly description: string;
  readonly ariaLabel: string;
  readonly value: number;
  readonly minimum: number;
  readonly maximum: number;
  readonly onChange: (value: number) => void;
}

function FontSizeField({
  label,
  description,
  ariaLabel,
  value,
  minimum,
  maximum,
  onChange,
}: FontSizeFieldProps) {
  return (
    <div className="flex flex-col gap-3 rounded-lg border border-border bg-background px-3 py-3 sm:flex-row sm:items-center sm:justify-between">
      <div>
        <p className="text-sm font-medium text-foreground">{label}</p>
        <p className="text-xs text-muted-foreground">{description}</p>
      </div>
      <div className="flex w-full shrink-0 items-center gap-3 sm:w-64">
        <input
          type="range"
          className="min-w-0 flex-1 accent-primary"
          aria-label={ariaLabel}
          min={minimum}
          max={maximum}
          step={1}
          value={value}
          onChange={(event) => onChange(Number(event.target.value))}
        />
        <output className="w-10 text-right font-mono text-xs tabular-nums">{value}px</output>
      </div>
    </div>
  );
}

const FONT_SETTING_KEYS = [
  "uiFontFamily",
  "uiFontSize",
  "chatFontFamily",
  "chatFontSize",
  "monoFontFamily",
  "terminalFontSize",
] as const;

export function AppearanceSettings() {
  const { theme, setTheme, resolvedTheme, settings, defaults, updateSettings } =
    useSettingsRouteContext();
  const fontsDifferFromDefaults = FONT_SETTING_KEYS.some((key) => settings[key] !== defaults[key]);

  return (
    <>
      <section className="rounded-2xl border border-border bg-card p-5">
        <div className="mb-4">
          <h2 className="text-sm font-medium text-foreground">Theme</h2>
          <p className="mt-1 text-xs text-muted-foreground">Choose how F5 looks across the app.</p>
        </div>

        <div className="space-y-4">
          <div className="space-y-2" role="radiogroup" aria-label="Theme preference">
            {THEME_OPTIONS.map((option) => {
              const selected = theme === option.value;
              return (
                <button
                  key={option.value}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  className={`flex w-full items-start justify-between rounded-lg border px-3 py-2 text-left transition-colors ${
                    selected
                      ? "border-primary/60 bg-primary/8 text-foreground"
                      : "border-border bg-background text-muted-foreground hover:bg-accent"
                  }`}
                  onClick={() => setTheme(option.value)}
                >
                  <span className="flex flex-col">
                    <span className="text-sm font-medium">{option.label}</span>
                    <span className="text-xs">{option.description}</span>
                  </span>
                  {selected ? (
                    <span className="rounded bg-primary/14 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-primary">
                      Selected
                    </span>
                  ) : null}
                </button>
              );
            })}
          </div>
          <p className="text-xs text-muted-foreground">
            Active theme: <span className="font-medium text-foreground">{resolvedTheme}</span>
          </p>
        </div>
      </section>

      <section className="rounded-2xl border border-border bg-card p-5">
        <div className="mb-4 flex items-start justify-between gap-3">
          <div>
            <h2 className="text-sm font-medium text-foreground">Fonts</h2>
            <p className="mt-1 text-xs text-muted-foreground">
              Font changes apply live to app chrome, chat, code, diffs, previews, and terminals.
            </p>
          </div>
          {fontsDifferFromDefaults ? (
            <Button
              size="xs"
              variant="outline"
              onClick={() => updateSettings(buildAppSettingsPatch(FONT_SETTING_KEYS, defaults))}
            >
              Restore defaults
            </Button>
          ) : null}
        </div>

        <div className="space-y-3">
          <FontFamilyField
            label="Interface font"
            description="Used by navigation, controls, settings, and preview chrome."
            ariaLabel="Interface font family"
            value={settings.uiFontFamily}
            curatedFamilies={CURATED_UI_FONT_FAMILIES}
            fallbackStack={DEFAULT_UI_FONT_STACK}
            onChange={(uiFontFamily) => updateSettings({ uiFontFamily })}
          />
          <FontSizeField
            label="Interface font size"
            description="Scales interface text and rem-based controls."
            ariaLabel="Interface font size"
            value={settings.uiFontSize}
            minimum={UI_FONT_SIZE_MIN}
            maximum={UI_FONT_SIZE_MAX}
            onChange={(uiFontSize) => updateSettings({ uiFontSize })}
          />
          <FontFamilyField
            label="Chat font"
            description="Used by assistant messages and the composer."
            ariaLabel="Chat font family"
            value={settings.chatFontFamily}
            curatedFamilies={CURATED_UI_FONT_FAMILIES}
            fallbackStack="var(--font-sans)"
            onChange={(chatFontFamily) => updateSettings({ chatFontFamily })}
          />
          <FontSizeField
            label="Chat font size"
            description="Sets assistant-message and composer text size."
            ariaLabel="Chat font size"
            value={settings.chatFontSize}
            minimum={CHAT_FONT_SIZE_MIN}
            maximum={CHAT_FONT_SIZE_MAX}
            onChange={(chatFontSize) => updateSettings({ chatFontSize })}
          />
          <FontFamilyField
            label="Code font"
            description="Used by code, diffs, file previews, user prompts, and terminals."
            ariaLabel="Code font family"
            value={settings.monoFontFamily}
            curatedFamilies={CURATED_MONO_FONT_FAMILIES}
            fallbackStack={DEFAULT_MONO_FONT_STACK}
            onChange={(monoFontFamily) => updateSettings({ monoFontFamily })}
          />
          <FontSizeField
            label="Terminal font size"
            description="Refits active terminals without restarting their sessions."
            ariaLabel="Terminal font size"
            value={settings.terminalFontSize}
            minimum={TERMINAL_FONT_SIZE_MIN}
            maximum={TERMINAL_FONT_SIZE_MAX}
            onChange={(terminalFontSize) => updateSettings({ terminalFontSize })}
          />
        </div>
      </section>
    </>
  );
}
