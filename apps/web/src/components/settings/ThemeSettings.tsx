import { useMemo, useRef, useState, type DragEvent } from "react";
import { CopyIcon, DownloadIcon, PencilIcon, PlusIcon, Trash2Icon, UploadIcon } from "lucide-react";

import {
  addCustomTheme,
  duplicateThemeDefinition,
  removeCustomTheme,
  resolveThemeIdAfterRemoval,
  updateCustomTheme,
} from "../../themeEditorStore";
import {
  getAvailableThemePalettes,
  getThemeContrastWarnings,
  parseCustomThemeLibrary,
  type ThemeDefinitionV1,
  type ThemePalette,
  type ThemeVariant,
} from "../../themePalette";
import { exportThemeDefinition, importThemeFile } from "../../vscodeThemeImport";
import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";
import { useSettingsRouteContext } from "./SettingsRouteContext";
import { ThemeEditorPanel } from "./ThemeEditorPanel";
import { ThemePreviewCircles } from "./ThemePreviewCircles";

export function ThemeSettings({ variant }: { readonly variant: ThemeVariant }) {
  const { settings, updateSettings } = useSettingsRouteContext();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [editing, setEditing] = useState<ThemeDefinitionV1 | null>(null);
  const [dragging, setDragging] = useState(false);
  const library = useMemo(
    () => parseCustomThemeLibrary(settings.customThemes),
    [settings.customThemes],
  );
  const palettes = useMemo(
    () => getAvailableThemePalettes(settings.customThemes),
    [settings.customThemes],
  );
  const effectiveThemeId = palettes.some((palette) => palette.id === settings.themeId)
    ? settings.themeId
    : palettes[0]?.id;

  const persistNewTheme = (definition: ThemeDefinitionV1) => {
    const customThemes = addCustomTheme(settings.customThemes, definition);
    updateSettings({ customThemes: [...customThemes], themeId: definition.id });
    setEditing(definition);
  };

  const importFile = async (file: File) => {
    try {
      const definition = await importThemeFile(file);
      persistNewTheme(definition);
      toastManager.add({ type: "success", title: `Imported ${definition.name}` });
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Theme import failed",
        description: error instanceof Error ? error.message : String(error),
      });
    }
  };

  const duplicate = (palette: ThemePalette) => {
    try {
      persistNewTheme(duplicateThemeDefinition(palette));
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Theme could not be duplicated",
        description: error instanceof Error ? error.message : String(error),
      });
    }
  };

  const exportTheme = (definition: ThemeDefinitionV1) => {
    const url = URL.createObjectURL(exportThemeDefinition(definition));
    try {
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `${definition.id}.json`;
      anchor.click();
    } finally {
      URL.revokeObjectURL(url);
    }
  };

  const handleDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragging(false);
    const file = event.dataTransfer.files[0];
    if (file) void importFile(file);
  };

  return (
    <div className="space-y-4" aria-label="Color theme library">
      <div className="grid gap-2 sm:grid-cols-2">
        {palettes.map((palette) => {
          const selected = effectiveThemeId === palette.id;
          const warnings = getThemeContrastWarnings(palette);
          return (
            <div
              key={palette.id}
              className={`rounded-xl border p-3 ${
                selected ? "border-primary/60 bg-primary/8" : "border-border bg-background"
              }`}
            >
              <button
                type="button"
                className="flex w-full items-center justify-between gap-3 text-left"
                aria-pressed={selected}
                onClick={() => updateSettings({ themeId: palette.id })}
              >
                <span className="min-w-0">
                  <span className="block truncate text-sm font-medium text-foreground">
                    {palette.name}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {palette.builtin ? "Built in" : "Custom"}
                    {warnings.length > 0 ? " · Contrast warning" : ""}
                  </span>
                </span>
                <ThemePreviewCircles palette={palette} variant={variant} />
              </button>
              <div className="mt-2 flex justify-end gap-1 border-t border-border/70 pt-2">
                <Button
                  size="icon-xs"
                  variant="ghost"
                  aria-label={`Duplicate ${palette.name}`}
                  onClick={() => duplicate(palette)}
                >
                  <CopyIcon className="size-3.5" />
                </Button>
                {!palette.builtin && palette.definition ? (
                  <>
                    <Button
                      size="icon-xs"
                      variant="ghost"
                      aria-label={`Edit ${palette.name}`}
                      onClick={() => setEditing(palette.definition ?? null)}
                    >
                      <PencilIcon className="size-3.5" />
                    </Button>
                    <Button
                      size="icon-xs"
                      variant="ghost"
                      aria-label={`Export ${palette.name}`}
                      onClick={() => exportTheme(palette.definition!)}
                    >
                      <DownloadIcon className="size-3.5" />
                    </Button>
                    <Button
                      size="icon-xs"
                      variant="ghost"
                      aria-label={`Delete ${palette.name}`}
                      onClick={() => {
                        if (!window.confirm(`Delete “${palette.name}”?`)) return;
                        updateSettings({
                          customThemes: [...removeCustomTheme(settings.customThemes, palette.id)],
                          themeId: resolveThemeIdAfterRemoval(settings.themeId, palette.id),
                        });
                        if (editing?.id === palette.id) setEditing(null);
                      }}
                    >
                      <Trash2Icon className="size-3.5 text-destructive-foreground" />
                    </Button>
                  </>
                ) : null}
              </div>
            </div>
          );
        })}
      </div>

      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          variant="outline"
          onClick={() => {
            const selected =
              palettes.find((palette) => palette.id === effectiveThemeId) ?? palettes[0];
            if (selected) duplicate(selected);
          }}
        >
          <PlusIcon className="size-4" /> New from current
        </Button>
        <Button size="sm" variant="outline" onClick={() => fileInputRef.current?.click()}>
          <UploadIcon className="size-4" /> Import JSON or VSIX
        </Button>
        <input
          ref={fileInputRef}
          className="hidden"
          type="file"
          accept=".json,.jsonc,.vsix,application/json"
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = "";
            if (file) void importFile(file);
          }}
        />
      </div>

      <div
        className={`rounded-xl border border-dashed px-4 py-5 text-center text-xs ${
          dragging
            ? "border-primary bg-primary/8 text-foreground"
            : "border-border text-muted-foreground"
        }`}
        onDragEnter={(event) => {
          event.preventDefault();
          setDragging(true);
        }}
        onDragOver={(event) => event.preventDefault()}
        onDragLeave={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false);
        }}
        onDrop={handleDrop}
      >
        Drop a local F5 theme, VS Code JSON/JSONC theme, or VSIX here. Files stay on this device.
      </div>

      {library.issues.length > 0 ? (
        <div className="rounded-lg border border-warning/40 bg-warning/8 px-3 py-2 text-xs text-warning-foreground">
          <p className="font-medium">Some stored themes are inactive but were not deleted.</p>
          {library.issues.slice(0, 3).map((issue) => (
            <p key={`${issue.index}:${issue.message}`}>{issue.message}</p>
          ))}
        </div>
      ) : null}

      {editing ? (
        <ThemeEditorPanel
          key={editing.id}
          definition={editing}
          variant={variant}
          onCancel={() => setEditing(null)}
          onSave={(definition) => {
            try {
              updateSettings({
                customThemes: [...updateCustomTheme(settings.customThemes, definition)],
                themeId: definition.id,
              });
              setEditing(null);
            } catch (error) {
              toastManager.add({
                type: "error",
                title: "Theme could not be saved",
                description: error instanceof Error ? error.message : String(error),
              });
            }
          }}
        />
      ) : null}
    </div>
  );
}
