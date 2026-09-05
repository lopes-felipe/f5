import { type ModelSelection, type ServerProvider } from "@t3tools/contracts";
import { useState } from "react";
import { useSettings, useUpdateSettings } from "../../hooks/useSettings";
import { getCustomModelOptionsByInstance } from "../../modelSelection";
import { deriveProviderInstanceEntries } from "../../providerInstances";
import { ProviderInstanceModelPicker } from "../chat/ProviderInstanceModelPicker";
import { TraitsPicker } from "../chat/TraitsPicker";

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
  const selectable = supported.filter((provider) =>
    entries.some((entry) => entry.instanceId === provider.instanceId && entry.enabled),
  );
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
      className="rounded-2xl border border-border bg-card p-5"
      data-settings-search-target="providers.session-notes"
    >
      <h2 className="text-sm font-medium text-foreground">Thread summaries</h2>
      <p className="mt-1 text-xs text-muted-foreground">
        Summaries for every thread use this model and the selected provider’s account. Changes apply
        to the next summary refresh.
      </p>
      <p className="mt-3 text-xs text-muted-foreground">
        Selected: {selected?.displayName ?? selection.instanceId} / {selection.model}
      </p>
      <div className="mt-2 flex flex-wrap items-center gap-2" aria-busy={saving}>
        <ProviderInstanceModelPicker
          instanceId={selection.instanceId}
          model={selection.model}
          lockedInstanceId={null}
          providers={selectable}
          modelOptionsByInstance={getCustomModelOptionsByInstance(settings, selectable)}
          disabled={saving}
          onInstanceModelChange={(instanceId, _driver, model) => {
            void save({ instanceId, model });
          }}
        />
        {!unavailable && selected && !saving ? (
          <TraitsPicker
            provider={selected.driverKind}
            models={selected.models}
            model={selection.model}
            modelOptions={selection.options}
            onModelOptionsChange={(options) => {
              void save({
                instanceId: selection.instanceId,
                model: selection.model,
                options: options ?? [],
              });
            }}
          />
        ) : null}
      </div>
      {unavailable ? (
        <p className="mt-2 text-xs text-amber-600" role="status">
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
