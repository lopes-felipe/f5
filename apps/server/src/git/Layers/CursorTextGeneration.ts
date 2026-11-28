import * as nodeFs from "node:fs/promises";

import { Effect, Option, Ref, Schema } from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";

import {
  DEFAULT_GIT_TEXT_GENERATION_MODEL_BY_PROVIDER,
  ProviderInstanceId,
  type CursorSettings,
  type ModelSelection,
} from "@t3tools/contracts";
import { sanitizeFeatureBranchName } from "@t3tools/shared/git";
import { createModelSelection } from "@t3tools/shared/model";

import { TextGenerationError } from "../Errors.ts";
import {
  type ThreadTitleGenerationResult,
  type TextGenerationShape,
} from "../Services/TextGeneration.ts";
import {
  buildBranchNamePrompt,
  toBranchNameGenerationResult,
  buildCommitMessagePrompt,
  buildPrContentPrompt,
  buildThreadTitlePrompt,
} from "../Prompts.ts";
import {
  extractJsonObject,
  sanitizeCommitSubject,
  sanitizePrTitle,
  sanitizeThreadTitle,
} from "../Utils.ts";
import {
  applyCursorAcpModelSelection,
  makeCursorAcpRuntime,
} from "../../provider/acp/CursorAcpSupport.ts";
import { CURSOR_ACP_CLIENT_INFO } from "../../provider/cursor/cursorAcpClientInfo.ts";
import {
  cursorCliConfigDir,
  deleteCursorAcpSession,
} from "../../provider/cursor/CursorNativeSessions.ts";

const CURSOR_TIMEOUT_MS = 180_000;
const DEFAULT_CURSOR_MODEL_SELECTION = createModelSelection(
  ProviderInstanceId.make("cursor"),
  DEFAULT_GIT_TEXT_GENERATION_MODEL_BY_PROVIDER.cursor,
);

const resolveInputModelSelection = (selection: ModelSelection | undefined, model?: string) =>
  selection ??
  createModelSelection(
    DEFAULT_CURSOR_MODEL_SELECTION.instanceId,
    model ?? DEFAULT_CURSOR_MODEL_SELECTION.model,
  );

function mapCursorAcpError(
  operation:
    | "generateCommitMessage"
    | "generatePrContent"
    | "generateBranchName"
    | "generateThreadTitle"
    | "generateStructuredJson"
    | (string & {}),
  detail: string,
  cause: unknown,
): TextGenerationError {
  return new TextGenerationError({
    operation,
    detail,
    ...(cause !== undefined ? { cause } : {}),
  });
}

function isTextGenerationError(error: unknown): error is TextGenerationError {
  return (
    typeof error === "object" &&
    error !== null &&
    "_tag" in error &&
    error._tag === "TextGenerationError"
  );
}

/**
 * Build a Cursor text-generation closure bound to a specific `CursorSettings`
 * payload. See `makeCodexAdapter` for the overall per-instance rationale.
 */
export interface CursorTextGenerationOptions {
  /**
   * Stable scratch workspace under F5 state. When set, every generation runs
   * there instead of the caller's workspace, and its native session files are
   * deleted after the agent exits, so text generation leaves no sessions behind.
   */
  readonly scratchDir?: string;
}

export const makeCursorTextGeneration = Effect.fn("makeCursorTextGeneration")(function* (
  cursorSettings: CursorSettings,
  environment: NodeJS.ProcessEnv = process.env,
  options: CursorTextGenerationOptions = {},
) {
  const commandSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  // The CLI writes `acp-sessions` and `chats` under its config dir.
  const configDir = cursorCliConfigDir(environment);
  const scratchDir = options.scratchDir;
  const ensureScratchDir = (operation: string) =>
    scratchDir === undefined
      ? Effect.void
      : Effect.tryPromise({
          try: () => nodeFs.mkdir(scratchDir, { recursive: true }),
          catch: (cause) =>
            new TextGenerationError({
              operation,
              detail: `Could not create Cursor's scratch folder: ${cause instanceof Error ? cause.message : String(cause)}`,
              cause,
            }),
        }).pipe(Effect.asVoid);

  const runCursorJson = <S extends Schema.Top>({
    operation,
    cwd,
    prompt,
    outputSchemaJson,
    modelSelection,
  }: {
    operation:
      | "generateCommitMessage"
      | "generatePrContent"
      | "generateBranchName"
      | "generateThreadTitle"
      | "generateStructuredJson"
      | (string & {});
    cwd: string;
    prompt: string;
    outputSchemaJson: S;
    modelSelection: ModelSelection;
  }): Effect.Effect<S["Type"], TextGenerationError, S["DecodingServices"]> =>
    Effect.gen(function* () {
      yield* ensureScratchDir(operation);
      const sessionCwd = scratchDir ?? cwd;
      const createdSessionId = yield* Ref.make<string | undefined>(undefined);
      return yield* runCursorJsonInSession({
        operation,
        cwd: sessionCwd,
        prompt,
        outputSchemaJson,
        modelSelection,
        createdSessionId,
      }).pipe(
        Effect.ensuring(
          // Runs after the scoped runtime closed, so the writer has exited.
          Ref.get(createdSessionId).pipe(
            Effect.flatMap((sessionId) =>
              scratchDir !== undefined && sessionId !== undefined
                ? deleteCursorAcpSession({ configDir, sessionId, cwd: sessionCwd })
                : Effect.void,
            ),
          ),
        ),
      );
    });

  const runCursorJsonInSession = <S extends Schema.Top>({
    operation,
    cwd,
    prompt,
    outputSchemaJson,
    modelSelection,
    createdSessionId,
  }: {
    operation: string;
    cwd: string;
    prompt: string;
    outputSchemaJson: S;
    modelSelection: ModelSelection;
    createdSessionId: Ref.Ref<string | undefined>;
  }): Effect.Effect<S["Type"], TextGenerationError, S["DecodingServices"]> =>
    Effect.gen(function* () {
      const outputRef = yield* Ref.make("");
      const runtime = yield* makeCursorAcpRuntime({
        cursorSettings,
        environment,
        childProcessSpawner: commandSpawner,
        cwd,
        clientInfo: CURSOR_ACP_CLIENT_INFO,
      });

      yield* runtime.handleSessionUpdate((notification) => {
        const update = notification.update;
        if (update.sessionUpdate !== "agent_message_chunk") {
          return Effect.void;
        }
        const content = update.content;
        if (content.type !== "text") {
          return Effect.void;
        }
        return Ref.update(outputRef, (current) => current + content.text);
      });

      const promptResult = yield* Effect.gen(function* () {
        const started = yield* runtime.start();
        yield* Ref.set(createdSessionId, started.sessionId);
        yield* Effect.ignore(runtime.setMode("ask"));
        yield* applyCursorAcpModelSelection({
          runtime,
          model: modelSelection.model,
          selections: modelSelection.options,
          mapError: ({ cause, configId, step }) =>
            mapCursorAcpError(
              operation,
              step === "set-config-option"
                ? `Failed to set Cursor ACP config option "${configId}" for text generation.`
                : "Failed to set Cursor ACP base model for text generation.",
              cause,
            ),
        });

        return yield* runtime.prompt({
          prompt: [{ type: "text", text: prompt }],
        });
      }).pipe(
        Effect.timeoutOption(CURSOR_TIMEOUT_MS),
        Effect.flatMap(
          Option.match({
            onNone: () =>
              Effect.fail(
                new TextGenerationError({
                  operation,
                  detail: "Cursor Agent request timed out.",
                }),
              ),
            onSome: (value) => Effect.succeed(value),
          }),
        ),
        Effect.mapError((cause) =>
          isTextGenerationError(cause)
            ? cause
            : mapCursorAcpError(operation, "Cursor ACP request failed.", cause),
        ),
      );

      const rawResult = (yield* Ref.get(outputRef)).trim();
      if (!rawResult) {
        return yield* new TextGenerationError({
          operation,
          detail:
            promptResult.stopReason === "cancelled"
              ? "Cursor ACP request was cancelled."
              : "Cursor Agent returned empty output.",
        });
      }

      return yield* Schema.decodeEffect(Schema.fromJsonString(outputSchemaJson))(
        extractJsonObject(rawResult),
      ).pipe(
        Effect.catchTag("SchemaError", (cause) =>
          Effect.fail(
            new TextGenerationError({
              operation,
              detail: "Cursor Agent returned invalid structured output.",
              cause,
            }),
          ),
        ),
      );
    }).pipe(
      Effect.mapError((cause) =>
        isTextGenerationError(cause)
          ? cause
          : mapCursorAcpError(operation, "Cursor ACP text generation failed.", cause),
      ),
      Effect.scoped,
    );

  const generateCommitMessage: TextGenerationShape["generateCommitMessage"] = Effect.fn(
    "CursorTextGeneration.generateCommitMessage",
  )(function* (input) {
    const { prompt, outputSchema } = buildCommitMessagePrompt({
      repositoryContext: input.repositoryContext,
      branch: input.branch,
      stagedSummary: input.stagedSummary,
      stagedPatch: input.stagedPatch,
      includeBranch: input.includeBranch === true,
      writingPreferences: input.writingPreferences,
    });

    const generated = yield* runCursorJson({
      operation: "generateCommitMessage",
      cwd: input.cwd,
      prompt,
      outputSchemaJson: outputSchema,
      modelSelection: resolveInputModelSelection(input.modelSelection, input.model),
    });

    return {
      subject: sanitizeCommitSubject(generated.subject),
      body: generated.body.trim(),
      ...("branch" in generated && typeof generated.branch === "string"
        ? { branch: sanitizeFeatureBranchName(generated.branch) }
        : {}),
    };
  });

  const generatePrContent: TextGenerationShape["generatePrContent"] = Effect.fn(
    "CursorTextGeneration.generatePrContent",
  )(function* (input) {
    const { prompt, outputSchema } = buildPrContentPrompt({
      repositoryContext: input.repositoryContext,
      baseBranch: input.baseBranch,
      headBranch: input.headBranch,
      commitSummary: input.commitSummary,
      diffSummary: input.diffSummary,
      diffPatch: input.diffPatch,
      writingPreferences: input.writingPreferences,
    });

    const generated = yield* runCursorJson({
      operation: "generatePrContent",
      cwd: input.cwd,
      prompt,
      outputSchemaJson: outputSchema,
      modelSelection: resolveInputModelSelection(input.modelSelection, input.model),
    });

    return {
      title: sanitizePrTitle(generated.title),
      body: generated.body.trim(),
    };
  });

  const generateBranchName: TextGenerationShape["generateBranchName"] = Effect.fn(
    "CursorTextGeneration.generateBranchName",
  )(function* (input) {
    const { prompt, outputSchema } = buildBranchNamePrompt({
      message: input.message,
      attachments: input.attachments,
      writingPreferences: input.writingPreferences,
    });

    const generated = yield* runCursorJson({
      operation: "generateBranchName",
      cwd: input.cwd,
      prompt,
      outputSchemaJson: outputSchema,
      modelSelection: resolveInputModelSelection(input.modelSelection, input.model),
    });

    return toBranchNameGenerationResult(generated);
  });

  const generateThreadTitle: TextGenerationShape["generateThreadTitle"] = Effect.fn(
    "CursorTextGeneration.generateThreadTitle",
  )(function* (input) {
    const { prompt, outputSchema } = buildThreadTitlePrompt(input);

    const generated = yield* runCursorJson({
      operation: "generateThreadTitle",
      cwd: input.cwd,
      prompt,
      outputSchemaJson: outputSchema,
      modelSelection: resolveInputModelSelection(input.modelSelection, input.model),
    });

    return {
      ...(generated.needsRefinement !== undefined
        ? { needsRefinement: generated.needsRefinement }
        : {}),
      title: sanitizeThreadTitle(generated.title),
    } satisfies ThreadTitleGenerationResult;
  });

  const generateStructuredJson: TextGenerationShape["generateStructuredJson"] = Effect.fn(
    "CursorTextGeneration.generateStructuredJson",
  )(function* (input) {
    return yield* runCursorJson({
      operation: input.operation,
      cwd: input.cwd,
      prompt: input.prompt,
      outputSchemaJson: input.outputSchema,
      modelSelection: resolveInputModelSelection(input.modelSelection, input.model),
    });
  });

  return {
    generateCommitMessage,
    generatePrContent,
    generateBranchName,
    generateThreadTitle,
    generateStructuredJson,
  } satisfies TextGenerationShape;
});

// NOTE: `CursorTextGenerationLive` (the singleton Layer) has been removed.
// `makeCursorTextGeneration(cursorConfig)` is now invoked directly by
// `CursorDriver.create()` so each provider instance owns its own closure.
