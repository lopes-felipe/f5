import { useSettings, useUpdateSettings } from "../../hooks/useSettings";
import { Input } from "../ui/input";
import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";

export function WorktreeLocationSettings() {
  const directory = useSettings((settings) => settings.worktreesDirectory);
  const { updateSettings } = useUpdateSettings();
  const save = (value: string) => {
    if (value === directory) return;
    void updateSettings({ worktreesDirectory: value }).catch((error: unknown) =>
      toastManager.add({
        type: "error",
        title: "Could not save worktree location",
        description: error instanceof Error ? error.message : String(error),
      }),
    );
  };
  return (
    <section
      className="space-y-3 rounded-xl border border-border bg-card p-5"
      data-settings-search-target="storage.worktree-location"
    >
      <h2 className="text-sm font-medium text-foreground">Worktree location</h2>
      <p className="text-xs text-muted-foreground">
        Folder on this machine where new worktrees are created, such as D:\worktrees or ~/worktrees.
        Existing worktrees stay where they are. Leave empty to use this profile's F5 worktrees
        folder.
      </p>
      <div className="flex items-center gap-2">
        <Input
          key={directory}
          aria-label="Worktree location"
          autoCapitalize="none"
          spellCheck={false}
          placeholder="Default"
          defaultValue={directory}
          onBlur={(event) => save(event.target.value.trim())}
        />
        {directory ? (
          <Button variant="outline" onClick={() => save("")}>
            Reset
          </Button>
        ) : null}
      </div>
    </section>
  );
}
