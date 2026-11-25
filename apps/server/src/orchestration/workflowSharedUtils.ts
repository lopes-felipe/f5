import type { OrchestrationThread, ProviderKind, WorkflowModelSlot } from "@t3tools/contracts";
import {
  estimateModelContextWindowTokens,
  normalizeModelSlug,
  roughTokenEstimateFromCharacters,
} from "@t3tools/shared/model";

import { truncateMiddleByCharacters } from "./outputTruncation.ts";
import { OrchestrationCommandInvariantError } from "./Errors.ts";

export const WORKFLOW_AUTHORITATIVE_ARTIFACT_TOKEN_SHARE = 0.5;
export const WORKFLOW_RENDERED_MESSAGE_CHAR_LIMIT = 116_000;
/** At most this many review turns of one run are in flight at once. */
export const WORKFLOW_MAX_ACTIVE_REVIEW_TURNS = 4;
/** Smallest per-plan length a run with more than two authors may be created with. */
export const WORKFLOW_MIN_PLAN_CHAR_BUDGET = 12_000;
/** Smallest share of a fan-in prompt (consolidation, synthesis) one artifact may get. */
export const WORKFLOW_FAN_IN_MIN_ARTIFACT_CHARS = 4_000;
/** Largest share any one fan-in artifact gets, matching `truncateWorkflowPromptArtifact`. */
export const WORKFLOW_FAN_IN_MAX_ARTIFACT_CHARS = 60_000;

export type WorkflowFitThread = Partial<
  Pick<
    OrchestrationThread,
    "estimatedContextTokens" | "model" | "modelSelection" | "modelContextWindowTokens"
  >
> & {
  readonly session?:
    | (Pick<NonNullable<OrchestrationThread["session"]>, "providerName"> &
        Partial<
          Pick<
            NonNullable<OrchestrationThread["session"]>,
            "modelContextWindowTokens" | "providerInstanceId"
          >
        >)
    | null;
};

interface WorkflowArtifactFitInput {
  readonly artifacts: ReadonlyArray<string>;
  readonly targetSlot: WorkflowModelSlot;
  readonly thread?: WorkflowFitThread | null;
  readonly contextUsageTokens?: number;
  readonly contextWindowTokens?: number;
  readonly promptFramingTokens?: number;
}

type WorkflowPromptFitInput = WorkflowArtifactFitInput & {
  readonly prompt: string;
  readonly artifactLabel: string;
  readonly enforceArtifactBudget: boolean;
};

export function workflowPromptFit(
  input: WorkflowPromptFitInput,
):
  | { readonly kind: "fits" }
  | { readonly kind: "rendered-ceiling" | "artifact-budget"; readonly detail: string } {
  if (input.prompt.length > WORKFLOW_RENDERED_MESSAGE_CHAR_LIMIT) {
    return {
      kind: "rendered-ceiling",
      detail: `${input.artifactLabel} rendered prompt is ${input.prompt.length} characters; maximum is ${WORKFLOW_RENDERED_MESSAGE_CHAR_LIMIT}.`,
    };
  }
  if (!input.enforceArtifactBudget && input.contextUsageTokens === undefined)
    return { kind: "fits" };
  const fit = workflowArtifactFit(input);
  const availableTokens = input.enforceArtifactBudget
    ? fit.availableTokens
    : contextHeadroom(input);
  return fit.estimatedTokens <= availableTokens
    ? { kind: "fits" }
    : {
        kind: "artifact-budget",
        detail: `${input.artifactLabel} requires an estimated ${fit.estimatedTokens} tokens; only ${availableTokens} ${input.enforceArtifactBudget ? "authoritative-artifact " : ""}tokens are available.`,
      };
}

export function workflowPromptFitError(
  input: WorkflowPromptFitInput & { readonly artifactBudgetRecovery?: string },
): OrchestrationCommandInvariantError | null {
  const fit = workflowPromptFit(input);
  return fit.kind === "fits"
    ? null
    : new OrchestrationCommandInvariantError({
        commandType: "workflow.turn.start",
        detail:
          fit.kind === "artifact-budget" && input.artifactBudgetRecovery
            ? `${fit.detail} ${input.artifactBudgetRecovery}`
            : fit.detail,
      });
}

export {
  isActiveWorkflow,
  isArchivedWorkflow,
  isDeletedWorkflow,
  partitionWorkflowsByArchive,
} from "@t3tools/shared/workflowArchive";

export function slugify(value: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized.length > 0 ? normalized : "workflow";
}

export function nextWorkflowSlug(existingSlugs: ReadonlySet<string>, baseTitle: string): string {
  const base = slugify(baseTitle);
  if (!existingSlugs.has(base)) {
    return base;
  }
  let counter = 2;
  while (existingSlugs.has(`${base}-${counter}`)) {
    counter += 1;
  }
  return `${base}-${counter}`;
}

export function slotLabel(slot: WorkflowModelSlot): string {
  return `${slot.provider}:${slot.model}`;
}

export function workflowPromptToolingGuidance(provider?: ProviderKind): string | null {
  switch (provider) {
    case "claudeAgent":
      return [
        "- Prefer dedicated tools over shell commands when a dedicated tool can inspect the same information.",
        "- Batch independent read-only inspections in parallel before you synthesize your conclusions.",
      ].join("\n");
    case "codex":
      return [
        "- Use direct repository inspection to ground your decisions; prefer `rg` and `rg --files` for fast search.",
        "- Parallelize independent read-only inspections when it improves coverage, but keep dependent edits and conclusions sequential.",
      ].join("\n");
    default:
      return null;
  }
}

export function joinPromptSections(sections: ReadonlyArray<string | null | undefined>): string {
  return sections
    .filter(
      (section): section is string => typeof section === "string" && section.trim().length > 0,
    )
    .join("\n\n");
}

export function providerGuidanceSection(provider?: ProviderKind): string | undefined {
  const guidance = workflowPromptToolingGuidance(provider);
  return guidance ? `## Provider-Specific Guidance\n${guidance}` : undefined;
}

type WorkflowConsumableThread = Pick<OrchestrationThread, "latestTurn" | "messages" | "session">;

export function completedTurnEvidenceAt(
  thread: Pick<OrchestrationThread, "latestTurn"> | null | undefined,
): string | null {
  if (!thread?.latestTurn || thread.latestTurn.state !== "completed") {
    return null;
  }
  return thread.latestTurn.completedAt ?? thread.latestTurn.requestedAt;
}

export function hasActiveRunningTurn(
  thread: Pick<OrchestrationThread, "latestTurn" | "session"> | null | undefined,
): boolean {
  return (
    thread?.latestTurn?.state === "running" &&
    thread.session?.status === "running" &&
    thread.session.activeTurnId === thread.latestTurn.turnId
  );
}

function consumableAssistantContent(
  message: WorkflowConsumableThread["messages"][number] | undefined,
): string | null {
  if (message?.role !== "assistant" || message.streaming) {
    return null;
  }

  const text = message.text.trim();
  if (text.length > 0) {
    return text;
  }

  const reasoning = (message.reasoningText ?? "").trim();
  return reasoning.length > 0 ? reasoning : null;
}

function isConsumableAssistantMessage(
  message: WorkflowConsumableThread["messages"][number] | undefined,
): message is WorkflowConsumableThread["messages"][number] {
  return consumableAssistantContent(message) !== null;
}

function latestTurnAssistantMessage(
  thread: Pick<WorkflowConsumableThread, "messages"> & {
    readonly latestTurn: Pick<
      NonNullable<WorkflowConsumableThread["latestTurn"]>,
      "turnId" | "assistantMessageId"
    >;
  },
  requireMatchingTurn: boolean,
): WorkflowConsumableThread["messages"][number] | null {
  const preferredAssistantMessageId = thread.latestTurn.assistantMessageId;
  if (preferredAssistantMessageId) {
    const preferred = thread.messages.find((message) => message.id === preferredAssistantMessageId);
    if (
      isConsumableAssistantMessage(preferred) &&
      (!requireMatchingTurn || preferred.turnId === thread.latestTurn.turnId)
    ) {
      return preferred;
    }
  }

  return (
    thread.messages
      .toReversed()
      .find(
        (message) =>
          message.turnId === thread.latestTurn.turnId && isConsumableAssistantMessage(message),
      ) ?? null
  );
}

export function latestAssistantText(thread: {
  readonly latestTurn: {
    readonly assistantMessageId: string | null;
  } | null;
  readonly messages: ReadonlyArray<{
    readonly id: string;
    readonly role: string;
    readonly text: string;
    readonly streaming: boolean;
  }>;
}): string | null {
  const preferredAssistantMessageId = thread.latestTurn?.assistantMessageId ?? null;
  if (preferredAssistantMessageId) {
    const preferred = thread.messages.find((message) => message.id === preferredAssistantMessageId);
    if (preferred && preferred.role === "assistant" && preferred.text.trim().length > 0) {
      return preferred.text.trim();
    }
  }
  const fallback = thread.messages
    .toReversed()
    .find(
      (message) =>
        message.role === "assistant" && !message.streaming && message.text.trim().length > 0,
    );
  return fallback?.text.trim() ?? null;
}

export function getFinishedConsumableLatestTurn(
  thread: WorkflowConsumableThread | null | undefined,
): ReturnType<typeof getFinishedConsumableTurn> {
  return getFinishedConsumableTurn(thread, thread?.latestTurn, false);
}

export function getFinishedConsumableTurn(
  thread: Omit<WorkflowConsumableThread, "latestTurn"> | null | undefined,
  turn:
    | (Pick<
        NonNullable<WorkflowConsumableThread["latestTurn"]>,
        "turnId" | "assistantMessageId"
      > & { readonly state: string })
    | null
    | undefined,
  requireMatchingTurn = true,
): {
  readonly turnId: NonNullable<WorkflowConsumableThread["latestTurn"]>["turnId"];
  readonly assistantMessageId: WorkflowConsumableThread["messages"][number]["id"];
  readonly assistantText: string;
} | null {
  if (!thread || turn?.state !== "completed") {
    return null;
  }
  if (thread.session?.status === "running" && thread.session.activeTurnId === turn.turnId) {
    return null;
  }

  const assistantMessage = latestTurnAssistantMessage(
    { messages: thread.messages, latestTurn: turn },
    requireMatchingTurn,
  );
  if (!assistantMessage) {
    return null;
  }

  const assistantText = consumableAssistantContent(assistantMessage);
  if (assistantText === null) {
    return null;
  }

  return {
    turnId: turn.turnId,
    assistantMessageId: assistantMessage.id,
    assistantText,
  };
}

export function isLatestTurnFinishedAndConsumable(
  thread: WorkflowConsumableThread | null | undefined,
): boolean {
  return getFinishedConsumableLatestTurn(thread) !== null;
}

export function getThreadAssistantText(
  thread: {
    readonly messages: ReadonlyArray<{
      readonly id: string;
      readonly role: string;
      readonly text: string;
      readonly streaming: boolean;
      readonly createdAt: string;
    }>;
    readonly latestTurn: { readonly assistantMessageId: string | null } | null;
  },
  assistantMessageId: string | null,
): string | null {
  if (assistantMessageId) {
    const message = thread.messages.find((entry) => entry.id === assistantMessageId);
    if (message && message.role === "assistant" && message.text.trim().length > 0) {
      return message.text.trim();
    }
  }
  return latestAssistantText(thread);
}

export type AssistantFeedbackSource = "text-only" | "reasoning-only" | "combined";

export interface AssistantFeedback {
  readonly text: string;
  readonly source: AssistantFeedbackSource;
}

/**
 * Extracts reviewer feedback from the last assistant message in a thread, combining the
 * assistant `text` and `reasoningText` fields so we do not silently drop content that the
 * model wrote only to its reasoning channel.
 *
 * Some providers (notably Codex/GPT-5) routinely emit only a short first-person preamble as
 * their assistant `text` while streaming the substantive findings through the reasoning
 * channel (stored in `reasoningText`). When handing reviewer feedback back to a plan/code
 * author we must forward both fields; otherwise the author receives preamble-only "feedback".
 *
 * This function is the *single authorized consumer* that re-merges reasoning content into a
 * reviewer payload. The upstream snapshot-reconciliation path in
 * `codexSnapshotReconciliation.ts` deliberately keeps reasoning out of the `text` channel
 * (via `isAssistantProviderSnapshotItem` excluding reasoning items and
 * `extractAssistantTextFromProviderSnapshotItem` avoiding `detail`/`summary`), so `text`
 * remains the "public" assistant output everywhere else. Only the reviewer→author handoff —
 * an internal agent-to-agent channel, not user-facing output — re-joins the two fields here.
 *
 * Returns `null` when no usable assistant content exists. Otherwise returns the composed
 * feedback alongside a `source` tag so callers can observe whether reasoning was the sole
 * source of the feedback (useful for logging / telemetry).
 */
export function formatAssistantFeedback(
  message: {
    readonly text: string;
    readonly reasoningText?: string | undefined;
  },
  combinedReasoningHeading = "Reviewer reasoning",
  preserveWhitespace = false,
): AssistantFeedback | null {
  const trimmedText = message.text.trim();
  const trimmedReasoning = (message.reasoningText ?? "").trim();
  const text = preserveWhitespace ? message.text : trimmedText;
  const reasoning = preserveWhitespace ? (message.reasoningText ?? "") : trimmedReasoning;
  if (!trimmedText && !trimmedReasoning) {
    return null;
  }
  if (!trimmedText) {
    return { text: reasoning, source: "reasoning-only" };
  }
  if (!trimmedReasoning) {
    return { text, source: "text-only" };
  }
  return {
    text: `${text}\n\n## ${combinedReasoningHeading}\n\n${reasoning}`,
    source: "combined",
  };
}

export function latestAssistantFeedback(
  thread: {
    readonly latestTurn: {
      readonly assistantMessageId: string | null;
    } | null;
    readonly messages: ReadonlyArray<{
      readonly id: string;
      readonly role: string;
      readonly text: string;
      readonly reasoningText?: string | undefined;
      readonly streaming: boolean;
    }>;
  },
  preferredAssistantMessageId?: string | null,
  options?: {
    readonly combinedReasoningHeading?: string;
  },
): AssistantFeedback | null {
  const combinedReasoningHeading = options?.combinedReasoningHeading ?? "Reviewer reasoning";
  const resolvedPreferredAssistantMessageId =
    preferredAssistantMessageId ?? thread.latestTurn?.assistantMessageId ?? null;
  if (resolvedPreferredAssistantMessageId) {
    const preferred = thread.messages.find(
      (message) => message.id === resolvedPreferredAssistantMessageId,
    );
    if (preferred && preferred.role === "assistant") {
      const formatted = formatAssistantFeedback(preferred, combinedReasoningHeading);
      if (formatted !== null) {
        return formatted;
      }
    }
  }

  for (const message of thread.messages.toReversed()) {
    if (message.role !== "assistant" || message.streaming) {
      continue;
    }
    const formatted = formatAssistantFeedback(message, combinedReasoningHeading);
    if (formatted !== null) {
      return formatted;
    }
  }

  return null;
}

export function reviewFeedbackForPinnedTurn(
  thread: Omit<Parameters<typeof latestAssistantFeedback>[0], "messages"> & {
    readonly messages: ReadonlyArray<
      Parameters<typeof latestAssistantFeedback>[0]["messages"][number] & {
        readonly turnId?: string | null;
      }
    >;
    readonly proposedPlans?: ReadonlyArray<{
      readonly turnId: string | null;
      readonly planMarkdown: string;
    }>;
  },
  turnId: string | null,
  messageId: string | null,
) {
  const pinnedMessageId =
    messageId ??
    (turnId
      ? thread.messages.findLast(
          (message) => message.turnId === turnId && message.role === "assistant",
        )?.id
      : null);
  const feedback =
    turnId && !pinnedMessageId ? null : latestAssistantFeedback(thread, pinnedMessageId);
  const plan = turnId ? thread.proposedPlans?.find((entry) => entry.turnId === turnId) : null;
  const pinnedMessage = thread.messages.find((message) => message.id === pinnedMessageId);
  // Compare the plan with the reply alone. Reasoning is attached to whichever
  // side wins, so counting it here would let a short summary with long
  // reasoning displace a full report submitted as a plan.
  const replyLength =
    pinnedMessage?.role === "assistant"
      ? pinnedMessage.text.trim().length
      : (feedback?.text.length ?? 0);
  return plan && plan.planMarkdown.length > replyLength
    ? formatAssistantFeedback({
        text: plan.planMarkdown,
        reasoningText: pinnedMessage?.reasoningText,
      })
    : feedback;
}

/**
 * Shares a character budget among artifacts: shortest first, each gets
 * `min(length, floor(remaining / itemsLeft))`, capped at the per-artifact maximum. Short
 * artifacts stay whole and leave their unused share to the longer ones. Returns each
 * artifact's allowance in input order and the smallest allowance an oversized artifact got
 * (`null` when every artifact fits whole).
 */
export function allocateArtifactCharBudget(
  lengths: ReadonlyArray<number>,
  budget: number,
): { readonly allowances: number[]; readonly smallestExcerpt: number | null } {
  const allowances = Array.from({ length: lengths.length }, () => 0);
  let remaining = Math.max(0, Math.floor(budget));
  let smallestExcerpt: number | null = null;
  const order = lengths
    .map((length, index) => ({ length, index }))
    .toSorted((left, right) => left.length - right.length || left.index - right.index);
  for (const [position, entry] of order.entries()) {
    const share = Math.min(
      WORKFLOW_FAN_IN_MAX_ARTIFACT_CHARS,
      Math.floor(remaining / (order.length - position)),
    );
    const allowance = Math.min(entry.length, share);
    allowances[entry.index] = allowance;
    remaining -= allowance;
    if (allowance < entry.length) {
      smallestExcerpt = smallestExcerpt === null ? allowance : Math.min(smallestExcerpt, allowance);
    }
  }
  return { allowances, smallestExcerpt };
}

export function truncateWorkflowPromptArtifact(text: string, maxChars = 60_000): string {
  if (text.length <= maxChars) {
    return text;
  }
  const originalBytes = Buffer.byteLength(text, "utf8");
  const omittedUnits = Math.max(0, text.length - maxChars);
  const marker = `\n\n[... upstream report truncated; original ${text.length} UTF-16 units / ${originalBytes} UTF-8 bytes; at least ${omittedUnits} UTF-16 units omitted from the middle ...]\n\n`;
  return truncateMiddleByCharacters(text, {
    maxCharacters: maxChars,
    headCharacters: Math.floor(Math.max(0, maxChars - marker.length) * 0.6),
    marker,
  }).output;
}

/**
 * Where a workflow turn on `slot` will run in `thread`: the thread's session when
 * it is the same model on the same provider and instance, and the context window
 * that turn gets. A provider-reported window (session first, then the thread's
 * last report) wins over static metadata only for that matching model. Planning
 * revisions and Apply Reviews both size their prompts with this.
 */
export function workflowContextTarget<T extends WorkflowFitThread>(
  slot: WorkflowModelSlot,
  thread: T | null | undefined,
): {
  readonly session: NonNullable<T["session"]> | null;
  readonly matchingThread: boolean;
  readonly contextWindowTokens: number;
} {
  const staticWindow = estimateModelContextWindowTokens(slot.model, slot.provider);
  if (!thread) return { session: null, matchingThread: false, contextWindowTokens: staticWindow };
  const matchingModel =
    normalizeModelSlug(thread.model, slot.provider) ===
    normalizeModelSlug(slot.model, slot.provider);
  const matchingInstance =
    !thread.modelSelection ||
    thread.session?.providerInstanceId == null ||
    thread.session.providerInstanceId === thread.modelSelection.instanceId;
  const session =
    matchingModel && matchingInstance && thread.session?.providerName === slot.provider
      ? (thread.session as NonNullable<T["session"]>)
      : null;
  const matchingThread =
    matchingModel && (thread.session?.providerName == null || session !== null);
  return {
    session,
    matchingThread,
    contextWindowTokens:
      (session?.modelContextWindowTokens || undefined) ??
      (matchingThread ? thread.modelContextWindowTokens || undefined : undefined) ??
      staticWindow,
  };
}

function contextHeadroom(input: WorkflowArtifactFitInput): number {
  const contextWindow =
    input.contextWindowTokens ??
    workflowContextTarget(input.targetSlot, input.thread).contextWindowTokens;
  const outputReserve = Math.max(8_000, Math.floor(contextWindow * 0.15));
  const contextTokens = input.contextUsageTokens ?? input.thread?.estimatedContextTokens ?? 0;
  return Math.max(
    0,
    contextWindow - outputReserve - contextTokens - (input.promptFramingTokens ?? 0),
  );
}

export function workflowArtifactFit(input: WorkflowArtifactFitInput): {
  fits: boolean;
  estimatedTokens: number;
  availableTokens: number;
} {
  const availableTokens = Math.floor(
    contextHeadroom(input) * WORKFLOW_AUTHORITATIVE_ARTIFACT_TOKEN_SHARE,
  );
  const estimatedTokens = input.artifacts.reduce(
    (total, artifact) => total + roughTokenEstimateFromCharacters(artifact.length),
    0,
  );
  return { fits: estimatedTokens <= availableTokens, estimatedTokens, availableTokens };
}

export function hasPriorThreadWork(
  thread: Pick<OrchestrationThread, "latestTurn" | "messages"> | null | undefined,
): boolean {
  return Boolean(thread && (thread.latestTurn || thread.messages.length > 0));
}
