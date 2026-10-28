import { useSettings, useUpdateSettings } from "../../hooks/useSettings";
import { useEffect, useState } from "react";
import { Input } from "../ui/input";
import { Button } from "../ui/button";

export function WorktreeLocationSettings() {
  const directory = useSettings((settings) => settings.worktreesDirectory);
  const { updateSettings } = useUpdateSettings();
  const [draft, setDraft] = useState(directory);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  useEffect(() => setDraft(directory), [directory]);
  const save = async (value: string) => {
    if (value === directory) return;
    setSaving(true);
    setError(null);
    try {
      await updateSettings({ worktreesDirectory: value });
      setDraft(value);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  };
  return (
    <section
      className="space-y-3 rounded-xl border border-border bg-card p-5"
      data-settings-search-target="storage.worktree-location"
    >
      <h2 className="text-sm font-medium text-foreground">Worktree location</h2>
      <p className="text-xs text-muted-foreground">
        Folder on this machine where new worktrees are created, such as D:\worktrees or ~/worktrees.
        F5 creates a separate directory for each profile inside this folder. Existing worktrees stay
        where they are. Leave empty to use this profile's default folder.
      </p>
      <form
        className="flex items-center gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          void save(draft.trim());
        }}
      >
        <Input
          aria-label="Worktree location"
          autoCapitalize="none"
          spellCheck={false}
          placeholder="Default"
          value={draft}
          disabled={saving}
          aria-invalid={error !== null}
          aria-describedby={error ? "worktree-location-error" : undefined}
          onChange={(event) => setDraft(event.target.value)}
        />
        <Button type="submit" disabled={saving || draft.trim() === directory}>
          Save
        </Button>
        {directory ? (
          <Button type="button" variant="outline" disabled={saving} onClick={() => void save("")}>
            Reset
          </Button>
        ) : null}
      </form>
      {error ? (
        <p id="worktree-location-error" role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : null}
    </section>
  );
}
