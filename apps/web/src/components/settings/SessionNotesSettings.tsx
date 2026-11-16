import { type ModelSelection, type ServerProvider } from "@t3tools/contracts";
import { useState } from "react";
import { useSettings, useUpdateSettings } from "../../hooks/useSettings";
import { deriveProviderInstanceEntries } from "../../providerInstances";
import { GenerationModelPicker } from "./GenerationModelPicker";

export function SessionNotesSettings({ providers }: { providers: ReadonlyArray<ServerProvider> }) {
  const settings = useSettings();
  const { updateSettings } = useUpdateSettings();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const selection = settings.sessionNotesModelSelection;
  const supported = providers.filter(
    (provider) => provider.driver === "codex" || provider.driver === "claudeAgent",
  );
  const entries = deriveProviderInstanceEntries(supported);
  const selected = entries.find((entry) => entry.instanceId === selection.instanceId);
  const unavailable =
    !selected ||
    !selected.enabled ||
    !selected.isAvailable ||
    selected.status === "error" ||
    selected.status === "disabled";
  const save = async (next: ModelSelection) => {
    setSaving(true);
    setError(null);
    try {
      await updateSettings({ sessionNotesModelSelection: next });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not save summary settings.");
    } finally {
      setSaving(false);
    }
  };
  return (
    <section
      className="rounded-xl border border-border bg-card p-5"
      data-settings-search-target="threads.summaries"
    >
      <h2 className="text-sm font-medium text-foreground">Thread summaries</h2>
      <p className="mt-1 text-xs text-muted-foreground">
        Thread messages, activities, plans, tasks, and checkpoints are sent to the selected
        provider's account, including threads created with other providers. The default is
        Codex/OpenAI using GPT-5.6 Luna. Changes apply to the next summary refresh.
      </p>
      <p className="mt-3 text-xs text-muted-foreground">
        Selected: {selected?.displayName ?? selection.instanceId} / {selection.model}
      </p>
      <div className="mt-2 flex flex-wrap items-center gap-2" aria-busy={saving}>
        <GenerationModelPicker
          value={selection}
          providers={supported}
          disabled={saving}
          onChange={(value) => void save(value)}
        />
      </div>
      {unavailable ? (
        <p className="mt-2 text-xs text-warning-foreground" role="status">
          The selected summary provider is unavailable. Existing notes are kept until it is
          available or you choose another provider. No fallback model will be used.
        </p>
      ) : null}
      {error ? (
        <p className="mt-2 text-xs text-destructive" role="alert">
          {error}
        </p>
      ) : null}
    </section>
  );
}
