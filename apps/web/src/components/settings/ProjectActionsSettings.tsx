import type { ProjectScript } from "@t3tools/contracts";
import { PlusIcon } from "lucide-react";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ensureNativeApi } from "../../nativeApi";
import { parseProjectFileScripts } from "../../lib/projectFileScripts";

import { useProjectScriptMutations } from "~/hooks/useProjectScriptMutations";
import { shortcutLabelForCommand } from "~/keybindings";
import { commandForProjectScript } from "~/projectScripts";
import ProjectScriptDialog, { ScriptIcon } from "../ProjectScriptDialog";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Kbd } from "../ui/kbd";
import { useSettingsRouteContext } from "./SettingsRouteContext";

/** Settings → Project card for adding, editing, and removing a project's actions. */
export function ProjectActionsSettings() {
  const { selectedProject, keybindings } = useSettingsRouteContext();
  const { addScript, updateScript, deleteScript } = useProjectScriptMutations(selectedProject);
  const [editingScript, setEditingScript] = useState<ProjectScript | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const fileScripts = useQuery({
    queryKey: ["project-action-templates", selectedProject?.id, selectedProject?.cwd],
    enabled: !!selectedProject,
    retry: false,
    queryFn: async () => {
      const api = ensureNativeApi();
      const cwd = selectedProject!.cwd;
      const file = await api.projects
        .readFile({ cwd, relativePath: "f5.json" })
        .catch(() => api.projects.readFile({ cwd, relativePath: "t3.json" }));
      if (file.truncated) throw new Error("Project configuration is too large to inspect.");
      return { name: file.relativePath, scripts: parseProjectFileScripts(file.contents) };
    },
  });

  if (!selectedProject) {
    return null;
  }
  const scripts = selectedProject.scripts;

  const openAddDialog = () => {
    setEditingScript(null);
    setDialogOpen(true);
  };

  const openEditDialog = (script: ProjectScript) => {
    setEditingScript(script);
    setDialogOpen(true);
  };

  return (
    <section
      className="rounded-xl border border-border bg-card p-5"
      data-settings-search-target="project.actions"
    >
      <div className="mb-4">
        <h2 className="text-sm font-medium text-foreground">Actions</h2>
        <p className="mt-1 text-xs text-muted-foreground">
          Project commands you can run from the top bar or a shortcut, or automatically when a
          worktree is created or settles.
        </p>
      </div>

      {scripts.length === 0 ? (
        <p className="mb-3 text-xs text-muted-foreground">
          No actions yet. Add one to run a command from the top bar or set up new worktrees.
        </p>
      ) : (
        <ul className="mb-3 divide-y divide-border rounded-lg border border-border">
          {scripts.map((script) => {
            const shortcutLabel = shortcutLabelForCommand(
              keybindings,
              commandForProjectScript(script.id),
            );
            return (
              <li key={script.id} className="flex items-center gap-3 px-3 py-2">
                <ScriptIcon icon={script.icon} className="size-4 shrink-0 text-muted-foreground" />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="truncate text-sm text-foreground">{script.name}</span>
                    {script.runOnWorktreeCreate ? (
                      <Badge size="sm" variant="secondary">
                        Setup
                      </Badge>
                    ) : null}
                    {script.runOnWorktreeSettle ? (
                      <Badge size="sm" variant="secondary">
                        On settle
                      </Badge>
                    ) : null}
                  </div>
                  <p className="truncate font-mono text-xs text-muted-foreground">
                    {script.command}
                  </p>
                </div>
                {shortcutLabel ? <Kbd>{shortcutLabel}</Kbd> : null}
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  aria-label={`Edit ${script.name}`}
                  onClick={() => openEditDialog(script)}
                >
                  Edit
                </Button>
              </li>
            );
          })}
        </ul>
      )}

      <Button type="button" size="sm" variant="outline" onClick={openAddDialog}>
        <PlusIcon className="size-4" />
        Add action
      </Button>

      <ProjectScriptDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        editingScript={editingScript}
        scripts={scripts}
        keybindings={keybindings}
        onAddScript={addScript}
        onUpdateScript={updateScript}
        onDeleteScript={deleteScript}
      />
      <div className="mt-5 space-y-2 border-t border-border pt-4">
        <h3 className="text-sm font-medium">Repository action templates</h3>
        <p className="text-xs text-muted-foreground">
          Review each command before importing it. Imported actions have automatic execution turned
          off.
        </p>
        {fileScripts.isPending ? (
          <p className="text-xs">Checking f5.json and t3.json…</p>
        ) : fileScripts.isError ? (
          <p className="text-xs text-muted-foreground">
            No readable action templates. Check f5.json or t3.json for missing or invalid
            configuration.
          </p>
        ) : fileScripts.data.scripts.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            No actions declared in {fileScripts.data.name}.
          </p>
        ) : (
          fileScripts.data.scripts.map((script, index) => {
            const imported = scripts.some(
              (entry) => entry.name === script.name && entry.command === script.command,
            );
            return (
              <div key={index} className="rounded-md border border-border p-3">
                <p className="text-sm">{script.name}</p>
                <pre className="my-2 overflow-auto text-xs">{script.command}</pre>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={imported || importing}
                  onClick={() => {
                    setImporting(true);
                    setImportError(null);
                    void Promise.resolve(
                      addScript({
                        ...script,
                        runOnWorktreeCreate: false,
                        async: true,
                        keybinding: null,
                      }),
                    )
                      .catch((error: unknown) =>
                        setImportError(error instanceof Error ? error.message : "Import failed."),
                      )
                      .finally(() => setImporting(false));
                  }}
                >
                  {imported ? "Imported" : "Import action"}
                </Button>
              </div>
            );
          })
        )}
        {importError && (
          <p role="alert" className="text-xs text-destructive">
            {importError}
          </p>
        )}
      </div>
    </section>
  );
}
