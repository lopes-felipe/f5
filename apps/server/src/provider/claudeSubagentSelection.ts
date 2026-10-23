import {
  getEffectiveClaudeCodeEffort,
  normalizeModelSlug,
  resolveModelCapabilities,
  resolveReasoningEffortForProvider,
  resolveSupportedEffort,
} from "@t3tools/shared/model";

export interface ClaudeSubagentLaunch {
  readonly model?: string;
  /** Native effort, retained even when this model cannot display it, for nested inheritance. */
  readonly effort?: string;
  readonly ownerToolUseId?: string;
}
const text = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() && value.length <= 64 ? value.trim() : undefined;

export function rememberClaudeSubagentLaunch(input: {
  readonly pending: Map<string, ClaudeSubagentLaunch>;
  readonly reportedModels: ReadonlyMap<string, string>;
  readonly tasks: Iterable<{
    readonly toolUseId?: string;
    readonly model?: string;
    readonly effort?: string;
  }>;
  readonly toolUseId: string;
  readonly ownerToolUseId: string | null;
  readonly arguments: Record<string, unknown>;
  readonly sessionModel: string | undefined;
  readonly defaultSubagentModel?: string | undefined;
  readonly sessionEffort: string | undefined;
}): void {
  const ownerId = input.ownerToolUseId;
  let owner:
    | { readonly toolUseId?: string; readonly model?: string; readonly effort?: string }
    | undefined;
  if (ownerId)
    for (const task of input.tasks) {
      if (task.toolUseId === ownerId) {
        owner = task;
        break;
      }
    }
  const ownerLaunch = ownerId ? input.pending.get(ownerId) : undefined;
  const inheritedModel = ownerId
    ? (input.reportedModels.get(ownerId) ?? owner?.model ?? ownerLaunch?.model)
    : input.sessionModel;
  if (input.toolUseId.length > 1024 || (ownerId && ownerId.length > 1024)) return;
  const requestedModel =
    typeof input.arguments.model === "string" && input.arguments.model.length <= 4000
      ? input.arguments.model.trim()
      : undefined;
  const model = normalizeModelSlug(
    requestedModel === "inherit"
      ? inheritedModel
      : (requestedModel ?? input.defaultSubagentModel ?? inheritedModel),
    "claudeAgent",
  );
  const effort =
    text(input.arguments.effort) ??
    (ownerId ? (owner?.effort ?? ownerLaunch?.effort) : input.sessionEffort);
  const prior = input.pending.get(input.toolUseId);
  input.pending.set(input.toolUseId, {
    ...prior,
    ...(model ? { model } : {}),
    ...(effort ? { effort } : {}),
    ...(ownerId ? { ownerToolUseId: ownerId } : {}),
  });
  if (input.pending.size > 64) input.pending.delete(input.pending.keys().next().value!);
}

export function resolveClaudeSubagentEffort(
  model: string | undefined,
  effort: string | undefined,
  reported?: Parameters<typeof resolveModelCapabilities>[2],
): string | null {
  if (!model || !effort) return null;
  const native = getEffectiveClaudeCodeEffort(
    resolveReasoningEffortForProvider("claudeAgent", effort),
  );
  return resolveSupportedEffort(resolveModelCapabilities("claudeAgent", model, reported), native);
}
