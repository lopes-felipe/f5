import { ProviderDriverKind, type ServerProvider, type UpstreamPortReviewSettings } from "@t3tools/contracts";
import { getWorkflowModelCapabilities } from "../../providerModels";
import { SlotRow } from "../workflow/SlotRow";
import { WorkflowOptionCheckbox } from "../workflow/WorkflowOptions";
import { getWorkflowSlotDefaults, normalizeWorkflowSlotModelOptions, resolveSavedWorkflowSlot } from "../workflow/workflowSlots";

type ModelOptionsByProvider = Parameters<typeof getWorkflowSlotDefaults>[2];

export function portReviewDefaults(saved: UpstreamPortReviewSettings | undefined, models: ModelOptionsByProvider, providers: ReadonlyArray<ServerProvider>): UpstreamPortReviewSettings {
  const defaults = (key: "reviewerA" | "reviewerB" | "consolidation", slot: "branchA" | "branchB" | "merge", provider: "codex" | "claudeAgent") =>
    resolveSavedWorkflowSlot(saved?.[key], models, providers) ?? getWorkflowSlotDefaults(slot, provider, models, providers);
  return {
    enabled: saved?.enabled ?? true,
    reviewerA: defaults("reviewerA", "branchA", "codex"),
    reviewerB: defaults("reviewerB", "branchB", "claudeAgent"),
    consolidation: defaults("consolidation", "merge", "codex"),
  };
}

export function PortReviewOptions(props: {
  readonly value: UpstreamPortReviewSettings;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly modelOptionsByProvider: ModelOptionsByProvider;
  readonly locked: boolean;
  readonly onChange: (value: UpstreamPortReviewSettings) => void;
}) {
  return <div className="space-y-3">
    <WorkflowOptionCheckbox
      disabled={props.locked}
      checked={props.value.enabled}
      onCheckedChange={(enabled) => props.onChange({ ...props.value, enabled })}
      label="Code review after port"
      description="When the port opens a pull request, two models review it, a third consolidates their reports, and the port thread applies the consolidated feedback. Adds three review turns and one revision per thread."
    />
    {props.value.enabled && <section aria-label="Review models" className="space-y-2">
      <h3 className="text-sm font-medium">Review models</h3>
      {(["reviewerA", "reviewerB", "consolidation"] as const).map((key) => {
        const slot = props.value[key];
        if (!slot) return null;
        return <SlotRow
          key={key} label={key === "reviewerA" ? "Reviewer A" : key === "reviewerB" ? "Reviewer B" : "Consolidation"}
          disabled={props.locked} provider={slot.provider} model={slot.model} modelOptions={slot.modelOptions}
          providers={props.providers} modelOptionsByProvider={props.modelOptionsByProvider}
          onProviderModelChange={(provider, model) => props.onChange({ ...props.value, [key]: { provider, model } })}
          onModelOptionsChange={(options) => props.onChange({
            ...props.value, [key]: { ...slot, modelOptions: normalizeWorkflowSlotModelOptions(
              slot.provider, slot.model, options,
              getWorkflowModelCapabilities(props.providers, ProviderDriverKind.make(slot.provider), slot.model),
            ) },
          })}
        />;
      })}
    </section>}
  </div>;
}
