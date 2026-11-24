import { isKnownProviderKind, ProviderDriverKind, type ProviderKind, type ServerProvider, type UpstreamPortReviewSettings, type UpstreamReviewerSlot, WORKFLOW_REVIEW_MAX_PARTICIPANTS } from "@t3tools/contracts";
import { workflowParticipantIds, workflowParticipantLabel } from "@t3tools/shared/workflowParticipants";
import { readOnlyWorkflowUnsupportedReason } from "@t3tools/shared/workflowProviders";
import { PlusIcon, XIcon } from "lucide-react";
import { getWorkflowModelCapabilities } from "../../providerModels";
import { Button } from "../ui/button";
import { SlotRow } from "../workflow/SlotRow";
import { pickNewWorkflowActorProvider } from "../workflow/workflowActorRows";
import { WorkflowOptionCheckbox } from "../workflow/WorkflowOptions";
import { getWorkflowSlotDefaults, getWorkflowSlotDefaultsForProvider, normalizeWorkflowSlotModelOptions, resolveSavedWorkflowSlot } from "../workflow/workflowSlots";

type ModelOptionsByProvider = Parameters<typeof getWorkflowSlotDefaults>[2];

export function portReviewDefaults(saved: UpstreamPortReviewSettings | undefined, models: ModelOptionsByProvider, providers: ReadonlyArray<ServerProvider>): UpstreamPortReviewSettings {
  const available = providers.filter((provider) =>
    provider.enabled && isKnownProviderKind(provider.driver) && provider.driver !== "grok");
  const defaults = (key: "reviewerA" | "reviewerB" | "consolidation", slot: "branchA" | "branchB" | "merge", provider: "codex" | "claudeAgent") => {
    const preferred = resolveSavedWorkflowSlot(saved?.[key], models, available) ??
      resolveSavedWorkflowSlot(getWorkflowSlotDefaults(slot, provider, models, available), models, available);
    if (preferred) return preferred;
    const fallback = available[0];
    return fallback && isKnownProviderKind(fallback.driver)
      ? resolveSavedWorkflowSlot({ provider: fallback.driver, model: models[fallback.driver as ProviderKind][0]?.slug ?? "" }, models, available)
      : null;
  };
  // A saved extra whose provider is unavailable stays as saved: its row shows why it can't run,
  // and the user replaces or removes it rather than losing it silently on the next save.
  const additionalReviewers = (saved?.additionalReviewers ?? []).map(
    (slot) => resolveSavedWorkflowSlot(slot, models, available) ?? slot,
  );
  return {
    enabled: saved?.enabled ?? true,
    reviewerA: defaults("reviewerA", "branchA", "codex"),
    reviewerB: defaults("reviewerB", "branchB", "claudeAgent"),
    ...(additionalReviewers.length > 0 ? { additionalReviewers } : {}),
    consolidation: defaults("consolidation", "merge", "codex"),
  };
}

/** Every reviewer row in roster order, A first. */
function reviewerRows(value: UpstreamPortReviewSettings): Array<{ readonly label: string; readonly slot: UpstreamReviewerSlot | null; readonly extraIndex: number | null }> {
  const extras = value.additionalReviewers ?? [];
  const ids = workflowParticipantIds(2 + extras.length);
  return [
    { label: "Reviewer A", slot: value.reviewerA, extraIndex: null },
    { label: "Reviewer B", slot: value.reviewerB, extraIndex: null },
    ...extras.map((slot, index) => ({ label: `Reviewer ${workflowParticipantLabel(ids[index + 2]!)}`, slot, extraIndex: index })),
  ];
}

function withAdditionalReviewers(value: UpstreamPortReviewSettings, extras: ReadonlyArray<UpstreamReviewerSlot>): UpstreamPortReviewSettings {
  const { additionalReviewers: _omit, ...rest } = value;
  return extras.length > 0 ? { ...rest, additionalReviewers: [...extras] } : rest;
}

export function portReviewOptionsError(value: UpstreamPortReviewSettings, providers: ReadonlyArray<ServerProvider>): string | null {
  if (!value.enabled) return null;
  const slots = [...reviewerRows(value).map(({ label, slot }) => ({ label, slot })), { label: "Consolidation", slot: value.consolidation }];
  for (const { label, slot } of slots) {
    if (!slot?.model || slot.provider === "grok" ||
      !providers.some((provider) => provider.enabled && provider.driver === slot.provider))
      return label + ": choose an enabled provider that supports code review, or turn off code review.";
    const unsupported = readOnlyWorkflowUnsupportedReason(slot.provider, providers);
    if (unsupported) return `${label}: ${unsupported}`;
  }
  return null;
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
      description={(() => {
        const count = reviewerRows(props.value).length;
        return count === 2
          ? "When the port opens a pull request, two models review it, a third consolidates their reports, and the port thread applies the consolidated feedback. Adds three review turns and one revision per thread."
          : `When the port opens a pull request, ${count} models review it, another consolidates their reports, and the port thread applies the consolidated feedback. Adds ${count + 1} review turns and one revision per thread.`;
      })()}
    />
    {props.value.enabled && <section aria-label="Review models" className="space-y-2">
      <h3 className="text-sm font-medium">Review models</h3>
      {[...reviewerRows(props.value), { label: "Consolidation", slot: props.value.consolidation, extraIndex: null, consolidation: true as const }].map((row) => {
        const slot = row.slot;
        if (!slot) return null;
        const write = (next: UpstreamReviewerSlot) => {
          if ("consolidation" in row) return props.onChange({ ...props.value, consolidation: next });
          if (row.extraIndex === null) return props.onChange({ ...props.value, [row.label === "Reviewer A" ? "reviewerA" : "reviewerB"]: next });
          const extras = [...(props.value.additionalReviewers ?? [])];
          extras[row.extraIndex] = next;
          props.onChange(withAdditionalReviewers(props.value, extras));
        };
        const extraIndex = row.extraIndex;
        return <SlotRow
          key={row.label} label={row.label}
          disabled={props.locked} provider={slot.provider} model={slot.model} modelOptions={slot.modelOptions}
          providers={props.providers} modelOptionsByProvider={props.modelOptionsByProvider}
          providerUnavailableReason={(provider) => readOnlyWorkflowUnsupportedReason(provider, props.providers)}
          onProviderModelChange={(provider, model) => write({ provider, model })}
          onModelOptionsChange={(options) => write({
            ...slot, modelOptions: normalizeWorkflowSlotModelOptions(
              slot.provider, slot.model, options,
              getWorkflowModelCapabilities(props.providers, ProviderDriverKind.make(slot.provider), slot.model),
            ),
          })}
          trailing={extraIndex !== null ? <Button type="button" size="icon-sm" variant="ghost" aria-label={`Remove ${row.label}`} disabled={props.locked}
            onClick={() => props.onChange(withAdditionalReviewers(props.value, (props.value.additionalReviewers ?? []).filter((_, index) => index !== extraIndex)))}>
            <XIcon aria-hidden="true" className="size-3.5" />
          </Button> : null}
        />;
      })}
      <Button type="button" size="xs" variant="ghost"
        disabled={props.locked || reviewerRows(props.value).length >= WORKFLOW_REVIEW_MAX_PARTICIPANTS}
        onClick={() => {
          const rows = reviewerRows(props.value).flatMap(({ slot }) => (slot ? [slot] : []));
          const provider = pickNewWorkflowActorProvider(rows, props.providers);
          const last = rows[rows.length - 1];
          const next: UpstreamReviewerSlot | null = provider
            ? getWorkflowSlotDefaultsForProvider(provider, props.modelOptionsByProvider, props.providers)
            : (last ?? null);
          if (!next) return;
          props.onChange(withAdditionalReviewers(props.value, [...(props.value.additionalReviewers ?? []), {
            provider: next.provider, model: next.model, ...(next.modelOptions ? { modelOptions: next.modelOptions } : {}),
          }]));
        }}>
        <PlusIcon aria-hidden="true" className="size-3.5" />
        Add reviewer
      </Button>
    </section>}
  </div>;
}
