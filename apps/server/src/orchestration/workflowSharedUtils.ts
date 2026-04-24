import type { OrchestrationThread, ProviderKind, WorkflowModelSlot } from "@t3tools/contracts";

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
  thread: WorkflowConsumableThread | null | undefined,
): WorkflowConsumableThread["messages"][number] | null {
  if (!thread?.latestTurn) {
    return null;
  }

  const preferredAssistantMessageId = thread.latestTurn.assistantMessageId;
  if (preferredAssistantMessageId) {
    const preferred = thread.messages.find((message) => message.id === preferredAssistantMessageId);
    if (isConsumableAssistantMessage(preferred)) {
      return preferred;
    }
  }

  return (
    thread.messages
      .toReversed()
      .find(
        (message) =>
          message.turnId === thread.latestTurn?.turnId && isConsumableAssistantMessage(message),
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
): {
  readonly turnId: NonNullable<WorkflowConsumableThread["latestTurn"]>["turnId"];
  readonly assistantMessageId: WorkflowConsumableThread["messages"][number]["id"];
  readonly assistantText: string;
} | null {
  if (!thread?.latestTurn || thread.latestTurn.state !== "completed") {
    return null;
  }
  if (
    thread.session?.status === "running" &&
    thread.session.activeTurnId === thread.latestTurn.turnId
  ) {
    return null;
  }

  const assistantMessage = latestTurnAssistantMessage(thread);
  if (!assistantMessage) {
    return null;
  }

  const assistantText = consumableAssistantContent(assistantMessage);
  if (assistantText === null) {
    return null;
  }

  return {
    turnId: thread.latestTurn.turnId,
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
function formatAssistantFeedback(message: {
  readonly text: string;
  readonly reasoningText?: string | undefined;
}): AssistantFeedback | null {
  const text = message.text.trim();
  const reasoning = (message.reasoningText ?? "").trim();
  if (text.length === 0 && reasoning.length === 0) {
    return null;
  }
  if (text.length === 0) {
    return { text: reasoning, source: "reasoning-only" };
  }
  if (reasoning.length === 0) {
    return { text, source: "text-only" };
  }
  return {
    text: `${text}\n\n## Reviewer reasoning\n\n${reasoning}`,
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
): AssistantFeedback | null {
  const resolvedPreferredAssistantMessageId =
    preferredAssistantMessageId ?? thread.latestTurn?.assistantMessageId ?? null;
  if (resolvedPreferredAssistantMessageId) {
    const preferred = thread.messages.find(
      (message) => message.id === resolvedPreferredAssistantMessageId,
    );
    if (preferred && preferred.role === "assistant") {
      const formatted = formatAssistantFeedback(preferred);
      if (formatted !== null) {
        return formatted;
      }
    }
  }

  for (const message of thread.messages.toReversed()) {
    if (message.role !== "assistant" || message.streaming) {
      continue;
    }
    const formatted = formatAssistantFeedback(message);
    if (formatted !== null) {
      return formatted;
    }
  }

  return null;
}
