/**
 * Cursor ACP extension methods (`cursor/*`).
 *
 * Public docs: https://cursor.com/docs/cli/acp#cursor-extension-methods
 *
 * Blocking requests (`ask_question`, `create_plan`) reply with an
 * `{ outcome: { outcome, ... } }` object. Todos, subagent tasks and image
 * generation are documented as notifications, but the CLI also sends them as
 * requests, so both forms are handled and requests get an outcome reply.
 */
import * as nodeFs from "node:fs/promises";
import * as nodePath from "node:path";

import type { ProviderUserInputAnswers, UserInputQuestion } from "@t3tools/contracts";
import type { RequestPermissionRequest, RequestPermissionResponse } from "effect-acp/schema";
import { Schema } from "effect";

const CursorAskQuestionOption = Schema.Struct({
  id: Schema.String,
  label: Schema.String,
});

const CursorAskQuestion = Schema.Struct({
  id: Schema.String,
  prompt: Schema.String,
  options: Schema.Array(CursorAskQuestionOption),
  allowMultiple: Schema.optional(Schema.Boolean),
});

export const CursorAskQuestionRequest = Schema.Struct({
  toolCallId: Schema.String,
  title: Schema.optional(Schema.String),
  questions: Schema.Array(CursorAskQuestion),
});

const CursorTodoStatus = Schema.String;

const CursorTodo = Schema.Struct({
  id: Schema.optional(Schema.String),
  content: Schema.optional(Schema.String),
  title: Schema.optional(Schema.String),
  status: Schema.optional(CursorTodoStatus),
});

const CursorPlanPhase = Schema.Struct({
  name: Schema.String,
  todos: Schema.Array(CursorTodo),
});

export const CursorCreatePlanRequest = Schema.Struct({
  toolCallId: Schema.String,
  name: Schema.optional(Schema.String),
  overview: Schema.optional(Schema.String),
  plan: Schema.String,
  todos: Schema.Array(CursorTodo),
  isProject: Schema.optional(Schema.Boolean),
  phases: Schema.optional(Schema.Array(CursorPlanPhase)),
});

export const CursorUpdateTodosRequest = Schema.Struct({
  toolCallId: Schema.String,
  todos: Schema.Array(CursorTodo),
  merge: Schema.Boolean,
});

export const CursorTaskRequest = Schema.Struct({
  toolCallId: Schema.String,
  description: Schema.optional(Schema.String),
  prompt: Schema.optional(Schema.String),
  subagentType: Schema.optional(Schema.Unknown),
  model: Schema.optional(Schema.String),
  agentId: Schema.optional(Schema.String),
  durationMs: Schema.optional(Schema.Number),
});

export const CursorGenerateImageRequest = Schema.Struct({
  toolCallId: Schema.String,
  description: Schema.optional(Schema.String),
  filePath: Schema.optional(Schema.String),
  referenceImagePaths: Schema.optional(Schema.Array(Schema.String)),
});

const MAX_LABEL_LENGTH = 512;

function optionLabel(option: { readonly id: string; readonly label: string }): string {
  return (option.label.trim() || option.id.trim() || "Option").slice(0, MAX_LABEL_LENGTH);
}

/**
 * Question cards carry the native option id as `value`, so duplicate labels
 * stay distinguishable and answers are matched by id.
 */
export function extractAskQuestions(
  params: typeof CursorAskQuestionRequest.Type,
): ReadonlyArray<UserInputQuestion> {
  return params.questions.map((question) => ({
    id: question.id,
    header: "Question",
    question: question.prompt.trim() || params.title?.trim() || "Cursor needs your input.",
    multiSelect: question.allowMultiple === true,
    // Cursor's reply carries option ids only, so typed text has nowhere to go.
    allowCustomAnswer: false,
    options:
      question.options.length > 0
        ? question.options.map((option) => {
            const label = optionLabel(option);
            // The exact id, so ids that differ only in whitespace stay distinct.
            return {
              label,
              description: label,
              ...(option.id.trim() ? { value: option.id } : {}),
            };
          })
        : [{ label: "OK", description: "Continue" }],
  }));
}

/** How a pending Cursor question settled. */
export type CursorQuestionOutcome =
  | {
      readonly outcome: "answered";
      readonly answers: ReadonlyArray<{
        readonly questionId: string;
        readonly selectedOptionIds: ReadonlyArray<string>;
      }>;
    }
  | { readonly outcome: "skipped"; readonly reason?: string }
  | { readonly outcome: "cancelled" };

/** Submitted values as given (not trimmed), so an exact option id can match first. */
function answerValues(raw: unknown): ReadonlyArray<string> {
  if (typeof raw === "string") return raw.trim() ? [raw] : [];
  if (Array.isArray(raw))
    return raw.flatMap((entry) => (typeof entry === "string" && entry.trim() ? [entry] : []));
  return [];
}

/**
 * Maps F5 answers to Cursor's outcome. Values match option ids first; older
 * persisted cards answered with labels, which still resolve to the first
 * option carrying that label. A submission with no recognised selection is a
 * skip (the card was dismissed); Stop settles as `cancelled` elsewhere.
 */
export function cursorAskQuestionOutcome(
  params: typeof CursorAskQuestionRequest.Type,
  answers: ProviderUserInputAnswers,
): CursorQuestionOutcome {
  let answeredAny = false;
  const entries = params.questions.map((question) => {
    const values = answerValues(answers[question.id]);
    const selected: string[] = [];
    if (question.options.length === 0) {
      if (values.length > 0) answeredAny = true;
    } else {
      for (const value of values) {
        const trimmed = value.trim();
        const option =
          question.options.find((candidate) => candidate.id === value) ??
          question.options.find((candidate) => candidate.id.trim() === trimmed) ??
          question.options.find((candidate) => optionLabel(candidate) === trimmed);
        if (option && !selected.includes(option.id)) selected.push(option.id);
      }
    }
    const limited = question.allowMultiple === true ? selected : selected.slice(0, 1);
    if (limited.length > 0) answeredAny = true;
    return { questionId: question.id, selectedOptionIds: limited };
  });
  if (!answeredAny) return { outcome: "skipped", reason: "The user skipped the question." };
  return { outcome: "answered", answers: entries };
}

export function cursorAskQuestionReply(outcome: CursorQuestionOutcome) {
  return { outcome };
}

const QUESTION_FALLBACK_SUFFIX = /^(.+)_q(\d+)$/;

/**
 * When Cursor cannot read a question reply it re-asks through
 * `session/request_permission`: kind `other`, only `allow_once`/`reject_once`
 * options, and a tool call id of `<question tool call id>_q<n>`. Such a request
 * must never be auto-approved. Returns the base question tool call id.
 */
export function cursorQuestionFallbackBaseId(
  request: RequestPermissionRequest,
): string | undefined {
  const kind = request.toolCall.kind ?? "other";
  if (kind !== "other") return undefined;
  if (request.options.length === 0) return undefined;
  if (
    !request.options.every(
      (option) => option.kind === "allow_once" || option.kind === "reject_once",
    )
  )
    return undefined;
  const match = QUESTION_FALLBACK_SUFFIX.exec(request.toolCall.toolCallId);
  return match?.[1];
}

/**
 * Reply to a fallback whose base question already settled in F5, or
 * `undefined` when the settled answer does not map to exactly one option. The
 * `_q<n>` numbering and per-choice option layout are unrecorded (an R0 row),
 * so an answer replays only for a single-question group with exactly one
 * selected choice whose label names the single `allow_once` option; anything
 * else is shown to the user again.
 */
export function cursorQuestionFallbackReply(
  request: RequestPermissionRequest,
  outcome: CursorQuestionOutcome,
  question: typeof CursorAskQuestionRequest.Type | undefined,
): RequestPermissionResponse | undefined {
  if (outcome.outcome === "cancelled") return { outcome: { outcome: "cancelled" } };
  const single = (kind: "allow_once" | "reject_once") => {
    const matching = request.options.filter((candidate) => candidate.kind === kind);
    return matching.length === 1 ? matching[0] : undefined;
  };
  const selected = (option: { readonly optionId: string } | undefined) =>
    option ? ({ outcome: { outcome: "selected", optionId: option.optionId } } as const) : undefined;
  if (outcome.outcome === "skipped") return selected(single("reject_once"));
  const [only, ...rest] = outcome.answers;
  if (!only || rest.length > 0 || only.selectedOptionIds.length !== 1) return undefined;
  const allow = single("allow_once");
  const options = question?.questions.find((entry) => entry.id === only.questionId)?.options;
  if (!allow || !options) return undefined;
  // The permission names one choice only if exactly one native choice carries that full
  // (untruncated) label, and it must be the choice the user selected.
  const normalize = (value: string) => value.trim().toLowerCase();
  const named = options.filter((option) => normalize(option.label) === normalize(allow.name));
  return named.length === 1 && named[0]!.id === only.selectedOptionIds[0]
    ? selected(allow)
    : undefined;
}

/** A fallback for a question F5 never saw is shown as a question card. */
export function cursorFallbackQuestion(request: RequestPermissionRequest): UserInputQuestion {
  return {
    id: request.toolCall.toolCallId,
    header: "Question",
    question: (request.toolCall.title?.trim() || "Cursor needs your input.").slice(0, 8000),
    multiSelect: false,
    allowCustomAnswer: false,
    options: request.options.map((option) => {
      const label = (option.name.trim() || option.optionId).slice(0, MAX_LABEL_LENGTH);
      return { label, description: label, value: option.optionId };
    }),
  };
}

export function cursorFallbackQuestionReply(
  request: RequestPermissionRequest,
  answers: ProviderUserInputAnswers | "cancelled",
): RequestPermissionResponse {
  if (answers === "cancelled") return { outcome: { outcome: "cancelled" } };
  const [value] = answerValues(answers[request.toolCall.toolCallId]);
  const option =
    request.options.find((candidate) => candidate.optionId === value) ??
    request.options.find((candidate) => candidate.name.trim() === value?.trim()) ??
    request.options.find((candidate) => candidate.kind === "reject_once");
  return option
    ? { outcome: { outcome: "selected", optionId: option.optionId } }
    : { outcome: { outcome: "cancelled" } };
}

export type CursorPlanOutcome = "accepted" | "rejected" | "cancelled";

/**
 * `create_plan` reply. F5 reviews plans after the turn, so the reply must end
 * the turn without executing. Which outcome does that is an R0 live-gate row;
 * until it is certified the legacy reply is kept unchanged.
 */
export function cursorCreatePlanReply(certifiedOutcome: CursorPlanOutcome | undefined) {
  if (certifiedOutcome === undefined) return { accepted: true } as const;
  return {
    outcome:
      certifiedOutcome === "rejected"
        ? { outcome: "rejected" as const, reason: "F5 reviews the plan before implementation." }
        : { outcome: certifiedOutcome },
  };
}

export function extractPlanMarkdown(params: typeof CursorCreatePlanRequest.Type): string {
  return params.plan || "# Plan\n\n(Cursor did not supply plan text.)";
}

export function cursorUpdateTodosReply(params: typeof CursorUpdateTodosRequest.Type) {
  return { outcome: { outcome: "accepted" as const, todos: params.todos } };
}

export function cursorTaskReply(params: typeof CursorTaskRequest.Type) {
  return {
    outcome: {
      outcome: "completed" as const,
      ...(params.agentId ? { agentId: params.agentId } : {}),
      ...(params.durationMs !== undefined ? { durationMs: params.durationMs } : {}),
    },
  };
}

export function cursorGenerateImageReply(params: typeof CursorGenerateImageRequest.Type) {
  return params.filePath
    ? { outcome: { outcome: "generated" as const, filePath: params.filePath } }
    : { outcome: { outcome: "cancelled" as const } };
}

function isInside(root: string, candidate: string): boolean {
  const relative = nodePath.relative(root, candidate);
  // A parent segment, not any name starting with `..` (`..diagram.png` is inside).
  const parent = relative === ".." || relative.startsWith(`..${nodePath.sep}`);
  return relative === "" || (!parent && !nodePath.isAbsolute(relative));
}

/**
 * A generated image is shown only when it lies inside the workspace or F5's
 * attachments directory, so the agent cannot surface arbitrary host files.
 */
export function cursorGeneratedImagePath(
  filePath: string,
  cwd: string,
  attachmentsDir: string,
): string | undefined {
  const trimmed = filePath.trim();
  if (!trimmed) return undefined;
  const resolved = nodePath.resolve(cwd, trimmed);
  if (!/\.(png|jpe?g|gif|webp)$/i.test(resolved)) return undefined;
  return isInside(nodePath.resolve(cwd), resolved) ||
    isInside(nodePath.resolve(attachmentsDir), resolved)
    ? resolved
    : undefined;
}

/**
 * `cursorGeneratedImagePath` plus a real-path check: a symlink inside the
 * workspace that points elsewhere is rejected, as is a file that does not
 * exist. Returns the real path of the image.
 */
export async function resolveCursorGeneratedImage(
  filePath: string,
  cwd: string,
  attachmentsDir: string,
): Promise<string | undefined> {
  const lexical = cursorGeneratedImagePath(filePath, cwd, attachmentsDir);
  if (!lexical) return undefined;
  const real = (target: string) => nodeFs.realpath(target).catch(() => undefined);
  const [image, realCwd, realAttachments] = await Promise.all([
    real(lexical),
    real(cwd),
    real(attachmentsDir),
  ]);
  if (!image || !/\.(png|jpe?g|gif|webp)$/i.test(image)) return undefined;
  const stat = await nodeFs.stat(image).catch(() => undefined);
  if (!stat?.isFile()) return undefined;
  return (realCwd && isInside(realCwd, image)) ||
    (realAttachments && isInside(realAttachments, image))
    ? image
    : undefined;
}

export function cursorSubagentTypeLabel(subagentType: unknown): string | undefined {
  if (typeof subagentType === "string")
    return subagentType === "unspecified" ? undefined : subagentType;
  if (
    subagentType &&
    typeof subagentType === "object" &&
    "custom" in subagentType &&
    typeof subagentType.custom === "string" &&
    subagentType.custom.trim()
  )
    return subagentType.custom.trim();
  return undefined;
}

export function extractTodosAsPlan(params: typeof CursorUpdateTodosRequest.Type): {
  readonly explanation?: string;
  readonly plan: ReadonlyArray<{
    readonly step: string;
    readonly status: "pending" | "inProgress" | "completed";
  }>;
} {
  const plan = params.todos.flatMap((todo) => {
    const step = todo.content?.trim() || todo.title?.trim() || "";
    if (step === "") {
      return [];
    }
    const status: "pending" | "inProgress" | "completed" =
      todo.status === "completed"
        ? "completed"
        : todo.status === "in_progress" || todo.status === "inProgress"
          ? "inProgress"
          : "pending";
    return [{ step, status }];
  });
  return { plan };
}
