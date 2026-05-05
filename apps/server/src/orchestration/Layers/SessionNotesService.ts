import {
  CommandId,
  ThreadSessionNotes,
  type OrchestrationEvent,
  type ThreadId,
} from "@t3tools/contracts";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import { Data, Effect, Layer, Schema, Stream } from "effect";

import { resolveThreadWorkspaceCwd } from "../../checkpointing/Utils.ts";
import { roughTokenEstimateFromCharacters } from "../../provider/providerContext.ts";
import { ProviderService } from "../../provider/Services/ProviderService.ts";
import { deriveActivePlan, deriveTaskLines } from "../compactionService.ts";
import { resolveOneOffPromptRoute } from "../oneOffPromptRouting.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import {
  SessionNotesService,
  type SessionNotesServiceShape,
} from "../Services/SessionNotesService.ts";

type SessionNotesTriggerEvent = Extract<
  OrchestrationEvent,
  { type: "thread.session-set" | "thread.compacted" | "thread.reverted" }
>;

const SESSION_NOTES_TITLE_LIMIT = 120;
const SESSION_NOTES_SECTION_LIMIT = 2_000;
const SESSION_NOTES_TOKEN_BUDGET = 12_000;
const SESSION_NOTES_RECENT_MESSAGE_COUNT = 12;
const SESSION_NOTES_RECENT_ACTIVITY_COUNT = 20;
const SESSION_NOTES_RECENT_CHECKPOINT_COUNT = 6;
const SESSION_NOTES_ONE_OFF_PROMPT_TIMEOUT_MS = 60_000;

class SessionNotesParseError extends Data.TaggedError("SessionNotesParseError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

const SESSION_NOTES_FIELDS = [
  "title",
  "currentState",
  "taskSpecification",
  "filesAndFunctions",
  "workflow",
  "errorsAndCorrections",
  "codebaseAndSystemDocumentation",
  "learnings",
  "keyResults",
  "worklog",
] as const;

const SESSION_NOTES_TRIM_ORDER = [
  "worklog",
  "keyResults",
  "codebaseAndSystemDocumentation",
  "filesAndFunctions",
  "workflow",
  "learnings",
  "taskSpecification",
  "errorsAndCorrections",
  "currentState",
] as const;

function shouldTriggerRefresh(event: SessionNotesTriggerEvent): boolean {
  if (event.type === "thread.compacted" || event.type === "thread.reverted") {
    return true;
  }
  return (
    event.payload.session.status === "ready" ||
    event.payload.session.status === "error" ||
    event.payload.session.status === "stopped"
  );
}

const sessionNotesCommandId = (tag: string) =>
  CommandId.makeUnsafe(`session-notes:${tag}:${crypto.randomUUID()}`);

function normalizeMultilineSection(value: string, maxChars: number): string {
  const normalized = value
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return normalized.length <= maxChars ? normalized : normalized.slice(0, maxChars).trim();
}

function normalizeTitle(value: string): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length <= SESSION_NOTES_TITLE_LIMIT
    ? normalized
    : normalized.slice(0, SESSION_NOTES_TITLE_LIMIT).trim();
}

function trimCodeFence(value: string): string {
  const fencedMatch = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(value.trim());
  return fencedMatch?.[1]?.trim() ?? value.trim();
}

/**
 * Extracts a JSON object from a response that may be wrapped in markdown
 * fences or padded with conversational prose (e.g. "Sure! Here is the JSON:
 * {...}"). The naive `indexOf('{')` / `lastIndexOf('}')` slice is unsafe
 * because stray braces in the preamble (e.g. "Format: {k:v}") cause the slice
 * to start at the preamble example and yield invalid (or worse, accidentally
 * parsable-but-wrong) JSON. Instead, we walk every `{` candidate and return
 * the first one whose balanced-brace range parses as valid JSON. Strings are
 * respected so braces inside quoted values don't throw off the depth counter.
 *
 * Falls back to the fence-trimmed text when no balanced brace-range parses,
 * so downstream `JSON.parse` still surfaces a clear error for callers.
 */
function extractJsonObject(value: string): string {
  const trimmed = trimCodeFence(value);

  const findBalancedObject = (startIdx: number): string | null => {
    let depth = 0;
    let inString = false;
    let escape = false;
    for (let idx = startIdx; idx < trimmed.length; idx += 1) {
      const ch = trimmed[idx];
      if (inString) {
        if (escape) {
          escape = false;
        } else if (ch === "\\") {
          escape = true;
        } else if (ch === '"') {
          inString = false;
        }
        continue;
      }
      if (ch === '"') {
        inString = true;
        continue;
      }
      if (ch === "{") {
        depth += 1;
      } else if (ch === "}") {
        depth -= 1;
        if (depth === 0) {
          return trimmed.slice(startIdx, idx + 1);
        }
      }
    }
    return null;
  };

  for (let idx = 0; idx < trimmed.length; idx += 1) {
    if (trimmed[idx] !== "{") continue;
    const candidate = findBalancedObject(idx);
    if (candidate === null) continue;
    try {
      JSON.parse(candidate);
      return candidate;
    } catch {
      // Try the next `{` — this one was prose-like or malformed.
    }
  }

  return trimmed;
}

const SESSION_NOTES_JSON_ONLY_REMINDER =
  "\n\nIMPORTANT: Your previous reply was not valid JSON." +
  " Respond with ONLY a single JSON object matching the schema described above." +
  " Do not include greetings, apologies, explanations, or markdown fences.";

function summarizeRecentMessages(
  messages: ReadonlyArray<{
    readonly role: string;
    readonly text: string;
    readonly createdAt: string;
  }>,
): string {
  return messages
    .toSorted((left, right) => left.createdAt.localeCompare(right.createdAt))
    .slice(-SESSION_NOTES_RECENT_MESSAGE_COUNT)
    .map(
      (message) =>
        `[${message.createdAt}] ${message.role.toUpperCase()}\n${normalizeMultilineSection(message.text, 600)}`,
    )
    .join("\n\n");
}

function summarizeRecentActivities(
  activities: ReadonlyArray<{
    readonly kind: string;
    readonly summary: string;
    readonly createdAt: string;
    readonly payload: unknown;
  }>,
): string {
  return activities
    .filter(
      (activity) =>
        activity.kind !== "runtime.configured" &&
        !activity.kind.startsWith("tool.") &&
        activity.kind !== "thread.compaction.completed",
    )
    .toSorted((left, right) => left.createdAt.localeCompare(right.createdAt))
    .slice(-SESSION_NOTES_RECENT_ACTIVITY_COUNT)
    .map((activity) => {
      const payloadPreview =
        activity.payload === undefined
          ? ""
          : `\nPayload: ${JSON.stringify(activity.payload).slice(0, 400)}`;
      return `[${activity.createdAt}] ${activity.kind}: ${activity.summary}${payloadPreview}`;
    })
    .join("\n\n");
}

function summarizeRecentCheckpoints(
  checkpoints: ReadonlyArray<{
    readonly checkpointTurnCount: number;
    readonly status: string;
    readonly completedAt: string;
    readonly files: ReadonlyArray<{
      readonly path: string;
      readonly additions: number;
      readonly deletions: number;
    }>;
  }>,
): string {
  return checkpoints
    .toSorted((left, right) => left.completedAt.localeCompare(right.completedAt))
    .slice(-SESSION_NOTES_RECENT_CHECKPOINT_COUNT)
    .map((checkpoint) => {
      const files =
        checkpoint.files.length === 0
          ? "no files"
          : checkpoint.files
              .map((file) => `${file.path} (+${file.additions}/-${file.deletions})`)
              .join(", ");
      return `[${checkpoint.completedAt}] Turn ${checkpoint.checkpointTurnCount} ${checkpoint.status}: ${files}`;
    })
    .join("\n");
}

function buildSessionNotesPrompt(input: {
  readonly now: string;
  readonly sourceLastInteractionAt: string;
  readonly existingNotesJson: string;
  readonly compactionSummary: string;
  readonly activePlan: string;
  readonly tasks: string;
  readonly recentMessages: string;
  readonly recentActivities: string;
  readonly recentCheckpoints: string;
}): string {
  return [
    "You are updating structured session notes for a coding thread.",
    "Return strict JSON only. Do not wrap it in markdown fences or add commentary.",
    "Do not use any tools.",
    "The JSON object must contain exactly these keys:",
    SESSION_NOTES_FIELDS.join(", "),
    "updatedAt, sourceLastInteractionAt",
    "",
    `Set "updatedAt" to "${input.now}".`,
    `Set "sourceLastInteractionAt" to "${input.sourceLastInteractionAt}".`,
    `Clamp the title to ${SESSION_NOTES_TITLE_LIMIT} characters and each other section to ${SESSION_NOTES_SECTION_LIMIT} characters.`,
    "Prefer concise, durable summaries over transcript-like repetition.",
    "",
    "## Existing Notes JSON",
    input.existingNotesJson,
    "",
    "## Compacted History Summary",
    input.compactionSummary,
    "",
    "## Current Task Snapshot",
    input.tasks,
    "",
    "## Latest Active Plan",
    input.activePlan,
    "",
    "## Recent Messages",
    input.recentMessages,
    "",
    "## Recent Non-Noisy Activities",
    input.recentActivities,
    "",
    "## Recent Checkpoints",
    input.recentCheckpoints,
  ].join("\n");
}

function buildSessionNotesCondensePrompt(input: {
  readonly now: string;
  readonly sourceLastInteractionAt: string;
  readonly notesJson: string;
}): string {
  return [
    "Condense the following session notes JSON so it stays within the requested budget.",
    "Return strict JSON only.",
    "Do not use any tools.",
    `Set "updatedAt" to "${input.now}" and "sourceLastInteractionAt" to "${input.sourceLastInteractionAt}".`,
    `Clamp the title to ${SESSION_NOTES_TITLE_LIMIT} characters and each other section to ${SESSION_NOTES_SECTION_LIMIT} characters.`,
    "",
    input.notesJson,
  ].join("\n");
}

const SessionNotesResponse = Schema.Struct({
  title: Schema.String,
  currentState: Schema.String,
  taskSpecification: Schema.String,
  filesAndFunctions: Schema.String,
  workflow: Schema.String,
  errorsAndCorrections: Schema.String,
  codebaseAndSystemDocumentation: Schema.String,
  learnings: Schema.String,
  keyResults: Schema.String,
  worklog: Schema.String,
  updatedAt: Schema.String,
  sourceLastInteractionAt: Schema.String,
});

const decodeSessionNotesResponse = Schema.decodeUnknownSync(SessionNotesResponse);
const decodeValidatedSessionNotes = Schema.decodeUnknownSync(ThreadSessionNotes);

function normalizeSessionNotes(input: {
  readonly raw: ReturnType<typeof decodeSessionNotesResponse>;
  readonly now: string;
  readonly sourceLastInteractionAt: string;
}) {
  return decodeValidatedSessionNotes({
    title: normalizeTitle(input.raw.title),
    currentState: normalizeMultilineSection(input.raw.currentState, SESSION_NOTES_SECTION_LIMIT),
    taskSpecification: normalizeMultilineSection(
      input.raw.taskSpecification,
      SESSION_NOTES_SECTION_LIMIT,
    ),
    filesAndFunctions: normalizeMultilineSection(
      input.raw.filesAndFunctions,
      SESSION_NOTES_SECTION_LIMIT,
    ),
    workflow: normalizeMultilineSection(input.raw.workflow, SESSION_NOTES_SECTION_LIMIT),
    errorsAndCorrections: normalizeMultilineSection(
      input.raw.errorsAndCorrections,
      SESSION_NOTES_SECTION_LIMIT,
    ),
    codebaseAndSystemDocumentation: normalizeMultilineSection(
      input.raw.codebaseAndSystemDocumentation,
      SESSION_NOTES_SECTION_LIMIT,
    ),
    learnings: normalizeMultilineSection(input.raw.learnings, SESSION_NOTES_SECTION_LIMIT),
    keyResults: normalizeMultilineSection(input.raw.keyResults, SESSION_NOTES_SECTION_LIMIT),
    worklog: normalizeMultilineSection(input.raw.worklog, SESSION_NOTES_SECTION_LIMIT),
    updatedAt: input.now,
    sourceLastInteractionAt: input.sourceLastInteractionAt,
  });
}

function estimateSessionNotesTokens(
  sessionNotes: ReturnType<typeof normalizeSessionNotes>,
): number {
  return roughTokenEstimateFromCharacters(JSON.stringify(sessionNotes).length);
}

function trimSessionNotesToBudget(
  sessionNotes: ReturnType<typeof normalizeSessionNotes>,
): ReturnType<typeof normalizeSessionNotes> {
  const nextNotes = { ...sessionNotes };

  for (const field of SESSION_NOTES_TRIM_ORDER) {
    while (estimateSessionNotesTokens(nextNotes) > SESSION_NOTES_TOKEN_BUDGET) {
      const currentValue = nextNotes[field];
      if (currentValue.length <= 200) {
        break;
      }
      nextNotes[field] =
        `${currentValue.slice(0, Math.max(0, currentValue.length - 200)).trim()}\n...[trimmed]`;
    }
  }

  return nextNotes;
}

const make = Effect.gen(function* () {
  const orchestrationEngine = yield* OrchestrationEngineService;
  const providerService = yield* ProviderService;
  const queuedThreadIds = new Set<ThreadId>();

  const warnInvalidNotes = (input: { readonly threadId: ThreadId; readonly detail: string }) =>
    Effect.logWarning("ignoring invalid session notes response", input);

  const refreshThreadNotes = (threadId: ThreadId) =>
    Effect.gen(function* () {
      const readModel = yield* orchestrationEngine.getReadModel();
      const thread = readModel.threads.find(
        (entry) => entry.id === threadId && entry.deletedAt === null,
      );
      if (!thread) {
        return;
      }
      if (
        thread.sessionNotes &&
        thread.lastInteractionAt.localeCompare(thread.sessionNotes.sourceLastInteractionAt) <= 0
      ) {
        return;
      }

      const now = new Date().toISOString();
      const notesRoute = resolveOneOffPromptRoute({
        model: thread.model,
        sessionProviderName: thread.session?.providerName ?? null,
      });
      const cwd = resolveThreadWorkspaceCwd({
        thread,
        projects: readModel.projects,
      });
      const prompt = buildSessionNotesPrompt({
        now,
        sourceLastInteractionAt: thread.lastInteractionAt,
        existingNotesJson: JSON.stringify(thread.sessionNotes ?? null),
        compactionSummary: thread.compaction?.summary ?? "[none]",
        activePlan: deriveActivePlan(thread) ?? "[none]",
        tasks: deriveTaskLines(thread.tasks).join("\n") || "[none]",
        recentMessages: summarizeRecentMessages(thread.messages),
        recentActivities: summarizeRecentActivities(thread.activities),
        recentCheckpoints: summarizeRecentCheckpoints(thread.checkpoints),
      });

      const invokeNotesProvider = (promptText: string) =>
        providerService.runOneOffPrompt({
          threadId: thread.id,
          provider: notesRoute.provider,
          prompt: promptText,
          ...(cwd ? { cwd } : {}),
          model: notesRoute.model,
          runtimeMode: thread.runtimeMode,
          timeoutMs: SESSION_NOTES_ONE_OFF_PROMPT_TIMEOUT_MS,
        });

      const response = yield* invokeNotesProvider(prompt);

      const parseNotes = (text: string) =>
        Effect.try({
          try: () => {
            const parsed = JSON.parse(extractJsonObject(text));
            return normalizeSessionNotes({
              raw: decodeSessionNotesResponse(parsed),
              now,
              sourceLastInteractionAt: thread.lastInteractionAt,
            });
          },
          catch: (cause) =>
            new SessionNotesParseError({
              message: cause instanceof Error ? cause.message : String(cause),
              cause,
            }),
        });

      // Models occasionally drop prose like "I'd be happy to help..." in front
      // of the JSON (or refuse entirely). Retry once with a stricter reminder
      // before logging the failure as a warning. The warning carries BOTH the
      // first and second error so operators can diagnose recurring formatting
      // regressions without flipping log level.
      let normalizedNotes = yield* parseNotes(response.text).pipe(
        Effect.catch((firstError) =>
          Effect.logDebug("session notes response invalid; retrying with stricter prompt", {
            threadId: thread.id,
            detail: firstError.message,
          }).pipe(
            Effect.flatMap(() => invokeNotesProvider(prompt + SESSION_NOTES_JSON_ONLY_REMINDER)),
            Effect.flatMap((retryResponse) =>
              parseNotes(retryResponse.text).pipe(
                Effect.catch((retryError) =>
                  warnInvalidNotes({
                    threadId: thread.id,
                    detail: `retry failed (first: ${firstError.message}; retry: ${retryError.message})`,
                  }).pipe(Effect.flatMap(() => Effect.fail(retryError))),
                ),
              ),
            ),
          ),
        ),
      );

      if (estimateSessionNotesTokens(normalizedNotes) > SESSION_NOTES_TOKEN_BUDGET) {
        // Mirror the main-prompt retry behavior: if the condense response
        // comes back as prose, retry once with the stricter reminder before
        // silently falling back to the un-condensed (over-budget) notes.
        const condensePrompt = buildSessionNotesCondensePrompt({
          now,
          sourceLastInteractionAt: thread.lastInteractionAt,
          notesJson: JSON.stringify(normalizedNotes),
        });
        const condensedResponse = yield* invokeNotesProvider(condensePrompt);

        normalizedNotes = yield* parseNotes(condensedResponse.text).pipe(
          Effect.catch((firstError) =>
            invokeNotesProvider(condensePrompt + SESSION_NOTES_JSON_ONLY_REMINDER).pipe(
              Effect.flatMap((retryResponse) => parseNotes(retryResponse.text)),
              Effect.tapError((retryError) =>
                Effect.logDebug("session notes condense retry failed; keeping un-condensed notes", {
                  threadId: thread.id,
                  detail: `first: ${firstError.message}; retry: ${retryError.message}`,
                }),
              ),
            ),
          ),
          Effect.orElseSucceed(() => normalizedNotes),
        );
      }

      const budgetedNotes =
        estimateSessionNotesTokens(normalizedNotes) > SESSION_NOTES_TOKEN_BUDGET
          ? trimSessionNotesToBudget(normalizedNotes)
          : normalizedNotes;

      yield* orchestrationEngine.dispatch({
        type: "thread.session-notes.record",
        commandId: sessionNotesCommandId("record"),
        threadId: thread.id,
        sessionNotes: budgetedNotes,
        createdAt: now,
      });
    });

  const worker = yield* makeDrainableWorker((threadId: ThreadId) =>
    Effect.sync(() => {
      queuedThreadIds.delete(threadId);
    }).pipe(
      Effect.flatMap(() => refreshThreadNotes(threadId)),
      Effect.catchCause((cause) =>
        Effect.logWarning("session notes refresh failed", {
          threadId,
          cause: String(cause),
        }),
      ),
    ),
  );

  const start: SessionNotesServiceShape["start"] = Effect.forkScoped(
    Stream.runForEach(orchestrationEngine.streamDomainEvents, (event) => {
      if (
        event.type !== "thread.session-set" &&
        event.type !== "thread.compacted" &&
        event.type !== "thread.reverted"
      ) {
        return Effect.void;
      }
      if (!shouldTriggerRefresh(event)) {
        return Effect.void;
      }
      if (queuedThreadIds.has(event.payload.threadId)) {
        return Effect.void;
      }
      queuedThreadIds.add(event.payload.threadId);
      return worker.enqueue(event.payload.threadId);
    }),
  ).pipe(Effect.asVoid);

  return {
    start,
    drain: worker.drain,
  } satisfies SessionNotesServiceShape;
});

export const SessionNotesServiceLive = Layer.effect(SessionNotesService, make);
