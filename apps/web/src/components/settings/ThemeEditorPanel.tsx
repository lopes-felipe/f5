import { useMemo, useState } from "react";

import {
  createCustomThemeDefinition,
  getThemeContrastWarnings,
  resolveThemePalette,
  type ThemeDefinitionV1,
  type ThemeTokenName,
  type ThemeVariant,
} from "../../themePalette";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { ThemeColorPicker } from "./ThemeColorPicker";
import { ThemePreviewCircles } from "./ThemePreviewCircles";

const EDITABLE_OVERRIDE_TOKENS = [
  ["background", "Background"],
  ["foreground", "Text"],
  ["primary", "Primary"],
  ["accent", "Accent"],
] as const satisfies ReadonlyArray<readonly [ThemeTokenName, string]>;

export function ThemeEditorPanel({
  definition,
  variant,
  onSave,
  onCancel,
}: {
  readonly definition: ThemeDefinitionV1;
  readonly variant: ThemeVariant;
  readonly onSave: (definition: ThemeDefinitionV1) => void;
  readonly onCancel: () => void;
}) {
  const [name, setName] = useState(definition.name);
  const [baseHue, setBaseHue] = useState(definition.parameters.baseHue);
  const [chroma, setChroma] = useState(definition.parameters.chroma);
  const [contrast, setContrast] = useState(definition.parameters.contrast);
  const [overrides, setOverrides] = useState(definition.overrides ?? {});

  const draft = useMemo(
    () =>
      createCustomThemeDefinition({
        id: definition.id,
        name: name.trim() || definition.name,
        parameters: { baseHue, chroma, contrast },
        ...(Object.keys(overrides).length > 0 ? { overrides } : {}),
      }),
    [baseHue, chroma, contrast, definition.id, definition.name, name, overrides],
  );
  const palette = resolveThemePalette(draft.id, [draft]);
  const warnings = getThemeContrastWarnings(palette);
  const currentColors = palette[variant];

  const setOverride = (token: ThemeTokenName, value: string) => {
    setOverrides((current) => ({
      ...current,
      [variant]: { ...current[variant], [token]: value },
    }));
  };

  return (
    <div className="space-y-4 rounded-xl border border-primary/30 bg-background p-4">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-sm font-medium text-foreground">Edit {definition.name}</p>
          <p className="text-xs text-muted-foreground">
            Parameters generate both variants; color overrides apply to {variant} only.
          </p>
        </div>
        <ThemePreviewCircles palette={palette} variant={variant} />
      </div>

      <label className="block space-y-1.5">
        <span className="text-xs font-medium text-foreground">Name</span>
        <Input
          nativeInput
          value={name}
          maxLength={80}
          onChange={(event) => setName(event.target.value)}
        />
      </label>

      <div className="grid gap-3 sm:grid-cols-3">
        <ParameterSlider
          label="Hue"
          value={baseHue}
          minimum={0}
          maximum={360}
          step={1}
          onChange={setBaseHue}
        />
        <ParameterSlider
          label="Chroma"
          value={chroma}
          minimum={0.02}
          maximum={0.3}
          step={0.005}
          onChange={setChroma}
        />
        <ParameterSlider
          label="Contrast"
          value={contrast}
          minimum={0.75}
          maximum={1.25}
          step={0.01}
          onChange={setContrast}
        />
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        {EDITABLE_OVERRIDE_TOKENS.map(([token, label]) => (
          <ThemeColorPicker
            key={token}
            label={`${label} (${variant})`}
            value={overrides[variant]?.[token] ?? currentColors[token]}
            onChange={(value) => setOverride(token, value)}
          />
        ))}
      </div>

      {warnings.length > 0 ? (
        <div className="rounded-lg border border-warning/40 bg-warning/8 px-3 py-2 text-xs text-warning-foreground">
          {warnings.map((warning) => (
            <p key={warning}>{warning}</p>
          ))}
        </div>
      ) : null}

      <div className="flex justify-end gap-2">
        <Button size="sm" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button size="sm" disabled={!name.trim()} onClick={() => onSave(draft)}>
          Save theme
        </Button>
      </div>
    </div>
  );
}

function ParameterSlider({
  label,
  value,
  minimum,
  maximum,
  step,
  onChange,
}: {
  readonly label: string;
  readonly value: number;
  readonly minimum: number;
  readonly maximum: number;
  readonly step: number;
  readonly onChange: (value: number) => void;
}) {
  return (
    <label className="space-y-1.5 rounded-lg border border-border px-3 py-2">
      <span className="flex justify-between gap-2 text-xs font-medium text-foreground">
        {label}
        <span className="font-mono text-muted-foreground">{value.toFixed(step < 0.1 ? 3 : 0)}</span>
      </span>
      <input
        className="w-full accent-primary"
        type="range"
        min={minimum}
        max={maximum}
        step={step}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
      />
    </label>
  );
}
