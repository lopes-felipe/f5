import {
  defaultInstanceIdForDriver,
  isKnownProviderKind,
  ProviderDriverKind,
  type ClaudeModelOptions,
  type ModelCapabilities,
  type ModelSlug,
  type ProviderInstanceId,
  type ProviderKind,
  type ProviderModelOptions,
  type ServerProvider,
} from "@t3tools/contracts";
import { resolveModelCapabilities } from "@t3tools/shared/model";
import { workflowProviderSnapshot } from "@t3tools/shared/workflowProviders";
import { useMemo, type ReactNode } from "react";

import { cn } from "../../lib/utils";
import { getWorkflowModelCapabilities } from "../../providerModels";
import { ProviderInstanceModelPicker } from "../chat/ProviderInstanceModelPicker";
import type { ModelPickerModelOption } from "../chat/providerIconUtils";
import { hasProviderTraitsControls, ProviderTraitsPicker } from "../chat/ProviderTraitsPicker";
import { fieldShellClassName } from "../ui/input";
import {
  normalizeWorkflowSlotModelOptions,
  WORKFLOW_HIDDEN_TRAITS,
  workflowPickerProviders,
  workflowSlotAppliesModelOptions,
} from "./workflowSlots";

const EMPTY_PROVIDERS: ReadonlyArray<ServerProvider> = [];
const EMPTY_MODELS: ServerProvider["models"] = [];

// The effort trigger fills its fixed-width field (the chevron pins to the trailing edge), so
// every row's effort column lines up; long combined labels clip. The selected value is a
// value, not a hint, so it gets full contrast.
const TRAITS_TRIGGER_CLASS_NAME =
  "h-7 w-full min-w-0 justify-start gap-1 overflow-hidden px-2 text-ui text-foreground";
const TRAITS_FIELD_WIDTH_CLASS_NAME = "w-32 shrink-0";

/**
 * A Claude slot without an effort runs at the model's own default, since workflow dispatch
 * sends none. The composer's Claude control would otherwise show its "high" thread default.
 */
function withDisplayedClaudeDefaultEffort(
  provider: ProviderKind,
  model: string,
  modelOptions: ProviderModelOptions | undefined,
  capabilities: ModelCapabilities,
): ProviderModelOptions | undefined {
  if (provider !== "claudeAgent" || modelOptions?.claudeAgent?.effort) return modelOptions;
  const defaultEffort = resolveModelCapabilities("claudeAgent", model, capabilities).defaultEffort;
  if (!defaultEffort) return modelOptions;
  return {
    ...modelOptions,
    claudeAgent: {
      ...modelOptions?.claudeAgent,
      effort: defaultEffort as NonNullable<ClaudeModelOptions["effort"]>,
    },
  };
}

/**
 * One workflow model slot: the composer's own provider-instance model picker and traits
 * control, limited to the instance workflow dispatch runs each provider on.
 */
export function SlotRow(props: {
  disabled?: boolean | undefined;
  label: string;
  provider: ProviderKind;
  model: ModelSlug;
  modelOptions: ProviderModelOptions | undefined;
  providers?: ReadonlyArray<ServerProvider> | undefined;
  modelOptionsByInstance: ReadonlyMap<ProviderInstanceId, ReadonlyArray<ModelPickerModelOption>>;
  onProviderModelChange: (provider: ProviderKind, model: ModelSlug) => void;
  onModelOptionsChange: (modelOptions: ProviderModelOptions | undefined) => void;
  /** Extra reason a provider cannot be picked for this slot. */
  providerUnavailableReason?: ((provider: ProviderKind) => string | null) | undefined;
  /** Shown under the row, for example a duplicate-model or provider error. */
  error?: string | null | undefined;
  /** Rendered after the picker, for example a Remove button. */
  trailing?: ReactNode;
  /**
   * Keep the effort column's width when this row has no effort control, so the model field
   * lines up with sibling rows that do.
   */
  reserveTraitsColumn?: boolean | undefined;
  /** Always render a fixed trailing cell (holding `trailing`, if any) so sibling rows align. */
  reserveTrailing?: boolean | undefined;
  className?: string | undefined;
}) {
  const providers = props.providers ?? EMPTY_PROVIDERS;
  const pickerProviders = useMemo(() => workflowPickerProviders(providers), [providers]);
  const snapshot = workflowProviderSnapshot(props.provider, providers);
  const driver = ProviderDriverKind.make(props.provider);
  const instanceId = snapshot?.instanceId ?? defaultInstanceIdForDriver(driver);
  const models = snapshot?.models ?? EMPTY_MODELS;
  const capabilities = getWorkflowModelCapabilities(providers, driver, props.model);
  // Show what the slot dispatches: an unsupported Codex effort walks down, a Claude pick is
  // clamped, rather than the control falling back to the model default.
  const displayedModelOptions = withDisplayedClaudeDefaultEffort(
    props.provider,
    props.model,
    normalizeWorkflowSlotModelOptions(
      props.provider,
      props.model,
      props.modelOptions,
      capabilities,
    ),
    capabilities,
  );
  const { providerUnavailableReason, onProviderModelChange } = props;
  const instanceUnavailableReason = useMemo(
    () =>
      providerUnavailableReason
        ? (instance: { readonly driverKind: ProviderDriverKind }) =>
            isKnownProviderKind(instance.driverKind)
              ? providerUnavailableReason(instance.driverKind)
              : null
        : undefined,
    [providerUnavailableReason],
  );
  const showTraits =
    workflowSlotAppliesModelOptions(props.provider) &&
    hasProviderTraitsControls({
      provider: props.provider,
      model: props.model,
      models,
      modelOptions: displayedModelOptions,
      hiddenOptions: WORKFLOW_HIDDEN_TRAITS,
    });
  const row = (
    <div
      data-slot="workflow-slot-row"
      role="group"
      aria-label={props.label}
      className={cn("flex min-w-0 items-center gap-3", props.className)}
    >
      <label className="w-24 shrink-0 truncate text-ui text-muted-foreground" title={props.label}>
        {props.label}
      </label>
      <div
        data-slot="workflow-slot-model"
        className={cn(fieldShellClassName, "flex h-9 min-w-0 flex-1 items-center px-1")}
      >
        <ProviderInstanceModelPicker
          providers={pickerProviders}
          disabled={props.disabled ?? false}
          instanceId={instanceId}
          model={props.model}
          lockedInstanceId={null}
          modelOptionsByInstance={props.modelOptionsByInstance}
          instanceUnavailableReason={instanceUnavailableReason}
          onInstanceModelChange={(_instanceId, pickedDriver, model) => {
            if (isKnownProviderKind(pickedDriver)) onProviderModelChange(pickedDriver, model);
          }}
          // Fill the field so every row's chevron lines up; a button centers its text by
          // default, so the label is pinned left. The selected model is a value, not a
          // hint, so it gets full contrast.
          triggerClassName="flex-1 max-w-none sm:max-w-none text-left text-foreground"
        />
      </div>
      {showTraits ? (
        <div
          data-slot="workflow-slot-traits"
          className={cn(
            fieldShellClassName,
            TRAITS_FIELD_WIDTH_CLASS_NAME,
            "flex h-9 items-center px-1",
          )}
        >
          <ProviderTraitsPicker
            disabled={props.disabled}
            provider={props.provider}
            models={models}
            model={props.model}
            modelOptions={displayedModelOptions}
            hiddenOptions={WORKFLOW_HIDDEN_TRAITS}
            triggerClassName={TRAITS_TRIGGER_CLASS_NAME}
            // A form field, not the composer chip: the level reads from the label alone.
            tint={false}
            onModelOptionsChange={(next) => {
              // Codex picks stay explicit and Claude picks are clamped to what the
              // model supports, exactly as they are dispatched.
              props.onModelOptionsChange(
                normalizeWorkflowSlotModelOptions(props.provider, props.model, next, capabilities),
              );
            }}
          />
        </div>
      ) : props.reserveTraitsColumn ? (
        <span aria-hidden="true" className={TRAITS_FIELD_WIDTH_CLASS_NAME} />
      ) : null}
      {props.reserveTrailing ? (
        <div className="flex w-7 shrink-0 items-center justify-center">{props.trailing}</div>
      ) : (
        props.trailing
      )}
    </div>
  );
  // The same tree with or without an error, so the row (and a focused picker in it) stays
  // mounted when the error appears or clears.
  return (
    <div className="flex min-w-0 flex-col gap-1">
      {row}
      {props.error ? (
        <p role="alert" className="ps-27 text-2xs text-destructive-foreground">
          {props.error}
        </p>
      ) : null}
    </div>
  );
}
