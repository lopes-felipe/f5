import type { ProjectScript } from "@t3tools/contracts";
import { PlusIcon } from "lucide-react";
import { useState } from "react";

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
    </section>
  );
}
