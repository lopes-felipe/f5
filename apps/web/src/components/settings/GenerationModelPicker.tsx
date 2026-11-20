import { projectProviderSnapshots } from "@t3tools/shared/serverSettings";
import { useSettingsRouteContext } from "./SettingsRouteContext";
import type { ModelSelection, ServerProvider } from "@t3tools/contracts";
import { useSettings } from "../../hooks/useSettings";
import { getCustomModelOptionsByInstance } from "../../modelSelection";
import { deriveProviderInstanceEntries } from "../../providerInstances";
import { ProviderInstanceModelPicker } from "../chat/ProviderInstanceModelPicker";
import { TraitsPicker } from "../chat/TraitsPicker";
import { NativeSelect } from "../ui/select";

export function GenerationModelPicker({
  value,
  providers,
  disabled = false,
  allowTextGenerators = true,
  onChange,
}: {
  value: ModelSelection;
  providers: ReadonlyArray<ServerProvider>;
  disabled?: boolean;
  allowTextGenerators?: boolean;
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
  const generator = settings.textGenerators[value.instanceId];
  return (
    <div className="flex flex-wrap items-center gap-2">
      {allowTextGenerators && Object.keys(settings.textGenerators).length > 0 && (
        <NativeSelect
          aria-label="Text generation source"
          disabled={disabled}
          value={generator ? value.instanceId : "agent"}
          onChange={(event) => {
            if (event.target.value === "agent") {
              const provider = selectable[0];
              if (provider?.models[0])
                onChange({ instanceId: provider.instanceId, model: provider.models[0].slug });
            } else {
              const entry = Object.entries(settings.textGenerators).find(
                ([id]) => id === event.target.value,
              );
              if (entry?.[1].models[0])
                onChange({
                  instanceId: entry[0] as ModelSelection["instanceId"],
                  model: entry[1].models[0],
                });
            }
          }}
        >
          <option value="agent">Coding agent</option>
          {Object.entries(settings.textGenerators)
            .filter(([, entry]) => entry.enabled)
            .map(([id, entry]) => (
              <option key={id} value={id}>
                {entry.label}
              </option>
            ))}
        </NativeSelect>
      )}
      {generator && allowTextGenerators ? (
        <NativeSelect
          aria-label="Text generator model"
          value={value.model}
          disabled={disabled}
          onChange={(event) =>
            onChange({ instanceId: value.instanceId, model: event.target.value })
          }
        >
          {generator.models.map((model) => (
            <option key={model}>{model}</option>
          ))}
        </NativeSelect>
      ) : (
        <>
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
        </>
      )}
    </div>
  );
}
