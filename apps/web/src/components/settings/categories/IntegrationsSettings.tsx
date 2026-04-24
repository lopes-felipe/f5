import { useMemo } from "react";

import { formatShortcutLabel } from "../../../keybindings";
import { formatKeybindingCommandLabel } from "../../../lib/keybindingConflicts";
import { useSettingsRouteContext } from "../SettingsRouteContext";
import { McpServersSettings } from "../McpServersSettings";
import { Button } from "../../ui/button";

export function IntegrationsSettings() {
  const {
    projects,
    keybindingConflicts,
    keybindingsConfigPath,
    isOpeningKeybindings,
    openKeybindingsError,
    openKeybindingsFile,
    selectedProjectSummary,
    hasProjects,
    settings,
  } = useSettingsRouteContext();
  const projectScripts = useMemo(() => projects.flatMap((project) => project.scripts), [projects]);

  return (
    <>
      <section className="rounded-2xl border border-border bg-card p-5">
        <div className="mb-4">
          <h2 className="text-sm font-medium text-foreground">Keybindings</h2>
          <p className="mt-1 text-xs text-muted-foreground">
            Open the persisted <code>keybindings.json</code> file to edit advanced bindings
            directly.
          </p>
        </div>

        <div className="space-y-3">
          <div className="flex items-center justify-between gap-3 rounded-lg border border-border bg-background px-3 py-2">
            <div className="min-w-0 flex-1">
              <p className="text-xs font-medium text-foreground">Config file path</p>
              <p className="mt-1 break-all font-mono text-[11px] text-muted-foreground">
                {keybindingsConfigPath ?? "Resolving keybindings path..."}
              </p>
            </div>
            <Button
              size="xs"
              variant="outline"
              disabled={!keybindingsConfigPath || isOpeningKeybindings}
              onClick={openKeybindingsFile}
            >
              {isOpeningKeybindings ? "Opening..." : "Open keybindings.json"}
            </Button>
          </div>

          <p className="text-xs text-muted-foreground">Opens in your preferred editor selection.</p>
          {openKeybindingsError ? (
            <p className="text-xs text-destructive">{openKeybindingsError}</p>
          ) : null}
          {keybindingConflicts.length > 0 ? (
            <div
              className="rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-3"
              data-keybinding-conflicts="true"
            >
              <p className="text-xs font-medium text-foreground">Conflicting shortcuts</p>
              <p className="mt-1 text-xs text-muted-foreground">
                These bindings overlap in the same context. Later rules win, so earlier commands can
                be shadowed.
              </p>
              <ul className="mt-3 space-y-2">
                {keybindingConflicts.slice(0, 6).map((conflict) => (
                  <li
                    key={`${conflict.winner.command}:${conflict.shadowed.command}:${conflict.shortcut.key}:${conflict.shortcut.modKey ? "m" : ""}${conflict.shortcut.metaKey ? "M" : ""}${conflict.shortcut.ctrlKey ? "c" : ""}${conflict.shortcut.altKey ? "a" : ""}${conflict.shortcut.shiftKey ? "s" : ""}`}
                  >
                    <p className="text-xs text-foreground">
                      <code>{formatShortcutLabel(conflict.shortcut)}</code> overlaps between{" "}
                      {formatKeybindingCommandLabel(conflict.winner.command, projectScripts)} and{" "}
                      {formatKeybindingCommandLabel(conflict.shadowed.command, projectScripts)}.
                    </p>
                  </li>
                ))}
              </ul>
              {keybindingConflicts.length > 6 ? (
                <p className="mt-2 text-xs text-muted-foreground">
                  {keybindingConflicts.length - 6} more conflict
                  {keybindingConflicts.length - 6 === 1 ? "" : "s"} hidden.
                </p>
              ) : null}
            </div>
          ) : null}
        </div>
      </section>

      <McpServersSettings
        selectedProject={selectedProjectSummary}
        hasProjects={hasProjects}
        codexBinaryPath={settings.codexBinaryPath}
        codexHomePath={settings.codexHomePath}
      />
    </>
  );
}
