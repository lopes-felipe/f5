import {
  defaultInstanceIdForDriver,
  type OrchestrationCommand,
  ProviderDriverKind,
  type ServerProvider,
  type WorkflowModelSlot,
} from "@t3tools/contracts";
import { normalizeModelSlug, resolveSelectableModel } from "@t3tools/shared/model";
import { Effect } from "effect";

import type { OrchestrationEngineShape } from "./Services/OrchestrationEngine.ts";

type WorkflowTurnStartCommand = Extract<
  OrchestrationCommand,
  { readonly type: "thread.turn.start" }
>;

/**
 * Resolve workflow slots against the provider's live model snapshot before
 * persisting or dispatching them. A known older Claude CLI omits gated models
 * from this snapshot, so stale built-ins and aliases fall back to the first
 * supported built-in instead of bypassing version gating.
 */
export function resolveAvailableWorkflowModelSlot(
  slot: WorkflowModelSlot,
  providers: ReadonlyArray<ServerProvider>,
): WorkflowModelSlot {
  const driver = ProviderDriverKind.make(slot.provider);
  const defaultInstanceId = defaultInstanceIdForDriver(driver);
  const provider =
    providers.find((candidate) => candidate.instanceId === defaultInstanceId) ??
    providers.find((candidate) => candidate.driver === driver);
  if (!provider || provider.models.length === 0) {
    return slot;
  }

  const selectedModel =
    resolveSelectableModel(driver, slot.model, provider.models) ??
    provider.models.find((model) => !model.isCustom)?.slug ??
    provider.models[0]?.slug;
  if (!selectedModel) {
    return slot;
  }

  const normalizedRequestedModel = normalizeModelSlug(slot.model, driver);
  return {
    provider: slot.provider,
    model: selectedModel,
    ...(slot.modelOptions && normalizedRequestedModel === selectedModel
      ? { modelOptions: slot.modelOptions }
      : {}),
  };
}

export function resolveAvailableWorkflowTurnCommand(
  command: WorkflowTurnStartCommand,
  providers: ReadonlyArray<ServerProvider>,
): WorkflowTurnStartCommand {
  if (!command.provider || !command.model) {
    return command;
  }

  const slot = resolveAvailableWorkflowModelSlot(
    {
      provider: command.provider,
      model: command.model,
      ...(command.modelOptions ? { modelOptions: command.modelOptions } : {}),
    },
    providers,
  );
  const { modelOptions: _discardedModelOptions, ...rest } = command;
  return {
    ...rest,
    provider: slot.provider,
    model: slot.model,
    ...(slot.modelOptions ? { modelOptions: slot.modelOptions } : {}),
  };
}

/**
 * Revalidate workflow model selections at the load-bearing dispatch boundary.
 * Provider snapshots are read for every turn, so a CLI downgrade that happens
 * after workflow creation also applies to retries, restart reconciliation, and
 * deferred merge/review/synthesis turns. Tests may omit ProviderRegistry; an
 * empty snapshot intentionally preserves the pre-guard behavior in that case.
 */
export function withWorkflowModelSelectionGuard(
  orchestrationEngine: OrchestrationEngineShape,
  getProviders: Effect.Effect<ReadonlyArray<ServerProvider>>,
): OrchestrationEngineShape {
  return {
    ...orchestrationEngine,
    dispatch: (command) => {
      if (command.type !== "thread.turn.start") {
        return orchestrationEngine.dispatch(command);
      }
      return Effect.flatMap(getProviders, (providers) =>
        orchestrationEngine.dispatch(resolveAvailableWorkflowTurnCommand(command, providers)),
      );
    },
  };
}
