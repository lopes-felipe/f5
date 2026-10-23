/**
 * Pure MSP → F5 projections used by `MuseAdapter`.
 *
 * Every function here is total over the wire's open string unions: an
 * unknown item kind becomes a generic tool item, an unknown approval choice
 * kind is omitted, and an unknown subject kind maps to `unknown`.
 *
 * @module provider/msp/MuseEventMapping
 */
import type {
  CanonicalItemType,
  CanonicalRequestType,
  ProviderApprovalDecision,
  ProviderApprovalOption,
  ProviderUserInputAnswers,
  RuntimeContentStreamKind,
  UserInputQuestion,
} from "@t3tools/contracts";
import type {
  ApprovalChoice,
  ApprovalRequestParams,
  ApprovalRequirementRef,
  Item,
  TodoItem,
  UserInputAnswer,
  UserInputQuestion as MspUserInputQuestion,
} from "@muse-code/sdk/dist/src/msp.js";

export const MUSE_APPROVAL_REQUEST_ID_SEPARATOR = "#";

/** `<approvalId>#<requirementId>`: one F5 request per MSP approval stage. */
export function museApprovalRequestId(
  approvalId: string,
  requirement: ApprovalRequirementRef,
): string {
  return `${approvalId}${MUSE_APPROVAL_REQUEST_ID_SEPARATOR}${requirement.approvalId}:${requirement.sourceIndex}`;
}

export function sameRequirement(left: ApprovalRequirementRef, right: ApprovalRequirementRef) {
  return left.approvalId === right.approvalId && left.sourceIndex === right.sourceIndex;
}

export interface MuseMappedChoice {
  readonly decision: ProviderApprovalDecision;
  readonly choiceId: string;
  readonly label: string;
}

/** Map one server-minted choice to an F5 decision, or omit it. */
export function museChoiceDecision(choice: ApprovalChoice): ProviderApprovalDecision | undefined {
  switch (choice.decision) {
    case "approved":
      return choice.scope === "session"
        ? "acceptForSession"
        : choice.scope === "localPersistent"
          ? "acceptAlways"
          : choice.scope === "once"
            ? "accept"
            : undefined;
    case "approvedForSession":
      return "acceptForSession";
    case "approvedPolicyAmendment":
      return "acceptAlways";
    case "denied":
    case "deniedPolicyAmendment":
      return "decline";
    case "abort":
      return "cancel";
    default:
      return undefined;
  }
}

/** The menu F5 shows: first choice per decision, Muse's own labels. */
export function mapMuseApprovalChoices(
  choices: ReadonlyArray<ApprovalChoice>,
): ReadonlyArray<MuseMappedChoice> {
  const mapped = new Map<ProviderApprovalDecision, MuseMappedChoice>();
  for (const choice of choices) {
    const decision = museChoiceDecision(choice);
    if (!decision || mapped.has(decision)) continue;
    const label = choice.label.trim() || decision;
    mapped.set(decision, { decision, choiceId: choice.choiceId, label });
  }
  return [...mapped.values()];
}

export function museApprovalOptions(
  choices: ReadonlyArray<MuseMappedChoice>,
): ReadonlyArray<ProviderApprovalOption> {
  return choices.map((choice) => ({ decision: choice.decision, label: choice.label }));
}

/** Workflow child IDs belong to Muse's child run, never an F5 parent turn. */
export function museApprovalTurnId(
  params: Pick<ApprovalRequestParams, "turnId" | "subagentOrigin">,
): string | undefined {
  return params.subagentOrigin ? undefined : params.turnId;
}

export function museRequestType(params: Pick<ApprovalRequestParams, "subject" | "toolName">) {
  const kind = params.subject.kind.toLowerCase();
  if (params.subject.command || kind.includes("command") || kind.includes("shell")) {
    return "exec_command_approval" satisfies CanonicalRequestType;
  }
  if (kind.includes("read")) return "file_read_approval" satisfies CanonicalRequestType;
  if (
    kind.includes("write") ||
    kind.includes("edit") ||
    kind.includes("patch") ||
    kind.includes("file")
  ) {
    return "file_change_approval" satisfies CanonicalRequestType;
  }
  if (kind.includes("network") || kind.includes("permission") || params.subject.host) {
    return "permissions_approval" satisfies CanonicalRequestType;
  }
  return "unknown" satisfies CanonicalRequestType;
}

export function museApprovalDetail(params: Pick<ApprovalRequestParams, "subject" | "toolName">) {
  const subject = params.subject;
  const parts = [
    subject.command,
    subject.path,
    subject.host ? `${subject.host}${subject.port ? `:${subject.port}` : ""}` : undefined,
    subject.target,
  ].filter((part): part is string => typeof part === "string" && part.trim().length > 0);
  return (parts[0] ?? `${params.toolName} (${subject.kind})`).slice(0, 2_000);
}

/** Structural check for an approval notification F5 can present and decide. */
export function decodeMuseApproval(raw: unknown): ApprovalRequestParams | undefined {
  if (!isRecord(raw)) return undefined;
  if (typeof raw.approvalId !== "string" || !raw.approvalId) return undefined;
  if (!isRequirement(raw.currentRequirementId)) return undefined;
  if (!Array.isArray(raw.availableChoices) || !raw.availableChoices.every(isChoice)) {
    return undefined;
  }
  if (!isRecord(raw.subject) || typeof raw.subject.kind !== "string") return undefined;
  if (typeof raw.toolName !== "string" || typeof raw.turnId !== "string") return undefined;
  if (raw.subagentOrigin !== undefined) {
    if (!isRecord(raw.subagentOrigin)) return undefined;
    const origin = raw.subagentOrigin;
    for (const field of ["subagentId", "childRunId", "childSessionId"] as const) {
      const value = origin[field];
      if (field !== "subagentId" && value === undefined) continue;
      if (typeof value !== "string" || !value.trim() || value.length > 1024) return undefined;
    }
  }
  return raw as unknown as ApprovalRequestParams;
}

/**
 * What an undecodable approval still lets F5 do: deny it when its ids and a
 * deny choice survive, otherwise nothing (the caller stops the session).
 */
export function salvageMuseDeny(raw: unknown):
  | {
      readonly approvalId: string;
      readonly requirementId: ApprovalRequirementRef;
      readonly choiceId: string;
    }
  | undefined {
  if (!isRecord(raw) || typeof raw.approvalId !== "string" || !raw.approvalId) return undefined;
  if (!isRequirement(raw.currentRequirementId)) return undefined;
  if (!Array.isArray(raw.availableChoices)) return undefined;
  const deny = raw.availableChoices.find(
    (choice) =>
      isRecord(choice) &&
      typeof choice.choiceId === "string" &&
      (choice.decision === "denied" || choice.decision === "deniedPolicyAmendment"),
  ) as { choiceId: string } | undefined;
  return deny
    ? {
        approvalId: raw.approvalId,
        requirementId: raw.currentRequirementId,
        choiceId: deny.choiceId,
      }
    : undefined;
}

export interface MuseProjectedItem {
  readonly itemType: CanonicalItemType;
  readonly status: "inProgress" | "completed" | "failed" | "declined";
  readonly title?: string;
  readonly detail?: string;
  readonly streamKind?: RuntimeContentStreamKind;
}

const COMMAND_TOOLS = /^(shell|bash|exec|run|command|terminal)/i;
const FILE_TOOLS = /(edit|write|patch|apply|create_file|delete_file|move)/i;
const WEB_TOOLS = /(web|fetch|search|browse)/i;

function toolItemType(item: Item): CanonicalItemType {
  const tool = item.tool ?? "";
  if (item.commandText || COMMAND_TOOLS.test(tool)) return "command_execution";
  if (item.patchSummary || item.patchRef || FILE_TOOLS.test(tool)) return "file_change";
  if (tool.startsWith("mcp")) return "mcp_tool_call";
  if (WEB_TOOLS.test(tool)) return "web_search";
  return "dynamic_tool_call";
}

function itemStatus(status: string): MuseProjectedItem["status"] {
  switch (status) {
    case "completed":
      return "completed";
    case "failed":
    case "timedOut":
      return "failed";
    case "cancelled":
    case "rejected":
      return "declined";
    default:
      return "inProgress";
  }
}

function nonEmpty(value: string | undefined | null, max = 4_000): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed.slice(0, max) : undefined;
}

/** `undefined` means F5 does not project the item (user messages are F5's own). */
export function projectMuseItem(item: Item): MuseProjectedItem | undefined {
  const status = itemStatus(item.status);
  switch (item.kind) {
    case "userMessage":
      return undefined;
    case "agentMessage": {
      const detail = nonEmpty(item.text, Number.MAX_SAFE_INTEGER);
      return {
        itemType: "assistant_message",
        status,
        streamKind: "assistant_text",
        ...(detail ? { detail } : {}),
      };
    }
    case "reasoning": {
      const detail = nonEmpty(item.text ?? item.summary?.join("\n"));
      return {
        itemType: "reasoning",
        status,
        streamKind: "reasoning_text",
        ...(detail ? { detail } : {}),
      };
    }
    case "compaction":
      return { itemType: "context_compaction", status, title: "Context compacted" };
    case "webSearch": {
      const detail = nonEmpty(item.displayText ?? item.args);
      return { itemType: "web_search", status, title: "Web search", ...(detail ? { detail } : {}) };
    }
    case "subagent": {
      const detail = nonEmpty(item.objective ?? item.displayText);
      return {
        itemType: "collab_agent_tool_call",
        status,
        title: nonEmpty(item.label) ?? "Subagent",
        ...(detail ? { detail } : {}),
      };
    }
    case "userShell": {
      const detail = nonEmpty(item.commandText);
      return {
        itemType: "command_execution",
        status,
        title: "Shell",
        streamKind: "command_output",
        ...(detail ? { detail } : {}),
      };
    }
    case "toolCall": {
      const itemType = toolItemType(item);
      const detail = nonEmpty(item.commandText ?? item.displayText ?? item.args);
      return {
        itemType,
        status,
        title: nonEmpty(item.tool) ?? "Tool",
        ...(itemType === "command_execution" ? { streamKind: "command_output" as const } : {}),
        ...(detail ? { detail } : {}),
      };
    }
    default: {
      // workflow, reminderChild, hookRun, sideChat, monitorFeed and any kind a
      // newer host adds: shown as a generic tool item.
      const detail = nonEmpty(item.displayText ?? item.statusLine ?? item.summary?.join("\n"));
      return {
        itemType: "dynamic_tool_call",
        status,
        title: nonEmpty(item.label ?? item.tool) ?? item.kind,
        ...(detail ? { detail } : {}),
      };
    }
  }
}

export function museDeltaStreamKind(
  item: Item | undefined,
  field: string | undefined,
): RuntimeContentStreamKind {
  if (field === "summary") return "reasoning_summary_text";
  if (!item) return "unknown";
  return projectMuseItem(item)?.streamKind ?? "unknown";
}

export function museTodoPlan(items: ReadonlyArray<TodoItem>) {
  return items.flatMap((item) => {
    const step = item.text.trim();
    if (!step || item.status === "cancelled") return [];
    const status =
      item.status === "completed"
        ? ("completed" as const)
        : item.status === "inProgress"
          ? ("inProgress" as const)
          : ("pending" as const);
    return [{ step, status }];
  });
}

export function museQuestions(
  questions: ReadonlyArray<MspUserInputQuestion>,
): ReadonlyArray<UserInputQuestion> {
  return questions.flatMap((question) => {
    const prompt = question.question.trim();
    if (!question.id.trim() || !prompt) return [];
    return [
      {
        id: question.id,
        header: question.header.trim() || "Question",
        question: prompt,
        options: question.options.flatMap((option) => {
          const label = option.label.trim();
          return label ? [{ label, description: option.description?.trim() || label }] : [];
        }),
        ...(question.selection.mode === "multiple" ? { multiSelect: true } : {}),
        ...(question.selection.minSelections === 0 ? { optional: true } : {}),
      },
    ];
  });
}

/** F5 answers (label, labels or free text per question id) → MSP answers. */
export function museAnswers(
  questions: ReadonlyArray<MspUserInputQuestion>,
  answers: ProviderUserInputAnswers,
): UserInputAnswer[] {
  return questions.flatMap((question): UserInputAnswer[] => {
    const value = answers[question.id];
    const labels = new Set(question.options.map((option) => option.label.trim()));
    if (Array.isArray(value)) {
      const selected = value.filter((entry): entry is string => typeof entry === "string");
      return selected.length > 0 ? [{ questionId: question.id, selectedLabels: selected }] : [];
    }
    if (typeof value !== "string" || !value.trim()) return [];
    const text = value.trim();
    return labels.has(text)
      ? [{ questionId: question.id, selectedLabel: text }]
      : [{ questionId: question.id, freeText: text }];
  });
}

export function museTurnState(terminal: string): "completed" | "failed" | "cancelled" {
  return terminal === "failed" ? "failed" : terminal === "cancelled" ? "cancelled" : "completed";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isRequirement(value: unknown): value is ApprovalRequirementRef {
  return (
    isRecord(value) && typeof value.approvalId === "string" && typeof value.sourceIndex === "number"
  );
}

function isChoice(value: unknown): value is ApprovalChoice {
  return (
    isRecord(value) &&
    typeof value.choiceId === "string" &&
    typeof value.decision === "string" &&
    typeof value.label === "string"
  );
}
