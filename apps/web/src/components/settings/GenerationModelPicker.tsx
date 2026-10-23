import { projectProviderSnapshots } from "@t3tools/shared/serverSettings";
import { useSettingsRouteContext } from "./SettingsRouteContext";
import type { ModelSelection, ServerProvider } from "@t3tools/contracts";
import { useSettings } from "../../hooks/useSettings";
import { getCustomModelOptionsByInstance } from "../../modelSelection";
import { deriveProviderInstanceEntries } from "../../providerInstances";
import { ProviderInstanceModelPicker } from "../chat/ProviderInstanceModelPicker";
import { TraitsPicker } from "../chat/TraitsPicker";

export function GenerationModelPicker({
  value,
  providers,
  disabled = false,
  onChange,
}: {
  value: ModelSelection;
  providers: ReadonlyArray<ServerProvider>;
  disabled?: boolean;
  onChange: (value: ModelSelection) => void;
}) {
  const settings = useSettings();
  const { selectedProject } = useSettingsRouteContext();
  const scopedProviders = projectProviderSnapshots(providers, settings, selectedProject?.id);
  const entries = deriveProviderInstanceEntries(scopedProviders);
  const selectable = scopedProviders.filter((provider) =>
    entries.some((entry) => entry.instanceId === provider.instanceId && entry.enabled),
  );
  const selected = entries.find((entry) => entry.instanceId === value.instanceId);
  return (
    <div className="flex flex-wrap items-center gap-2">
      <ProviderInstanceModelPicker
        instanceId={value.instanceId}
        model={value.model}
        lockedInstanceId={null}
        providers={selectable}
        modelOptionsByInstance={getCustomModelOptionsByInstance(settings, selectable)}
        disabled={disabled}
        onInstanceModelChange={(instanceId, _driver, model) => onChange({ instanceId, model })}
      />
      {selected ? (
        <TraitsPicker
          disabled={disabled}
          provider={selected.driverKind}
          models={selected.models}
          model={value.model}
          modelOptions={value.options}
          onModelOptionsChange={(options) => onChange({ ...value, options: options ?? [] })}
        />
      ) : null}
    </div>
  );
}
