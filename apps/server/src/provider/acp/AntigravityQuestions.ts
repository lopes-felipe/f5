import type {
  ProviderApprovalOption,
  ProviderUserInputAnswers,
  UserInputQuestion,
} from "@t3tools/contracts";
import type { RequestPermissionRequest, RequestPermissionResponse } from "effect-acp/schema";

export function antigravityQuestion(
  request: RequestPermissionRequest,
): UserInputQuestion | undefined {
  if (!request.toolCall.toolCallId.startsWith("interaction_") || request.options.length === 0)
    return undefined;
  const labels = request.options.map((option) => option.name.trim() || option.optionId);
  if (
    new Set(labels).size !== labels.length ||
    labels.some((label) => !label || label.length > 512)
  )
    return undefined;
  return {
    id: request.toolCall.toolCallId,
    header: "Antigravity question",
    question: (request.toolCall.title?.trim() || "Choose an option.").slice(0, 8000),
    multiSelect: false,
    options: labels.map((label) => ({ label, description: label })),
  };
}

export function antigravityQuestionResponse(
  request: RequestPermissionRequest,
  answers: ProviderUserInputAnswers,
): RequestPermissionResponse | undefined {
  const question = antigravityQuestion(request);
  if (!question) return undefined;
  const raw = answers[question.id];
  const answer =
    typeof raw === "string"
      ? raw
      : Array.isArray(raw) && raw.length === 1 && typeof raw[0] === "string"
        ? raw[0]
        : undefined;
  const index = question.options.findIndex((option) => option.label === answer);
  const option = request.options[index];
  return option ? { outcome: { outcome: "selected", optionId: option.optionId } } : undefined;
}

export function antigravityApprovalOptions(
  request: RequestPermissionRequest,
): ProviderApprovalOption[] {
  const choices: ProviderApprovalOption[] = [];
  if (request.options.some((option) => option.kind === "allow_once"))
    choices.push({ decision: "accept", label: "Allow once" });
  const always = request.options.find((option) => option.kind === "allow_always");
  if (always) {
    const value = always._meta?.["agy.security.warning"];
    const warning =
      value && typeof value === "object" && !Array.isArray(value)
        ? "message" in value && typeof value.message === "string"
          ? value.message.trim()
          : "title" in value && typeof value.title === "string"
            ? value.title.trim()
            : ""
        : "";
    choices.push({
      decision: "acceptForSession",
      label: "Allow for this thread",
      ...(warning ? { warning: warning.slice(0, 512) } : {}),
    });
  }
  if (request.options.some((option) => option.kind === "reject_once"))
    choices.push({ decision: "decline", label: "Deny" });
  choices.push({ decision: "cancel", label: "Cancel" });
  return choices;
}
