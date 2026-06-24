import {
  DEFAULT_GIT_TEXT_GENERATION_MODEL_BY_PROVIDER,
  ProviderInstanceId,
  type GrokSettings,
  type ModelSelection,
} from "@t3tools/contracts";
import { sanitizeBranchFragment, sanitizeFeatureBranchName } from "@t3tools/shared/git";
import { createModelSelection } from "@t3tools/shared/model";
import { Effect, Option, Ref, Schema } from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";
import type * as EffectAcpErrors from "effect-acp/errors";

import { TextGenerationError } from "../Errors.ts";
import {
  type ThreadTitleGenerationResult,
  type TextGenerationShape,
} from "../Services/TextGeneration.ts";
import {
  buildBranchNamePrompt,
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
  applyGrokAcpModelSelection,
  currentGrokModelIdFromSessionSetup,
  makeGrokAcpRuntime,
  resolveGrokAcpBaseModelId,
} from "../../provider/acp/GrokAcpSupport.ts";

const GROK_TIMEOUT_MS = 180_000;
const DEFAULT_GROK_MODEL_SELECTION = createModelSelection(
  ProviderInstanceId.make("grok"),
  DEFAULT_GIT_TEXT_GENERATION_MODEL_BY_PROVIDER.grok,
);

const resolveInputModelSelection = (selection: ModelSelection | undefined, model?: string) =>
  selection ??
  createModelSelection(
    DEFAULT_GROK_MODEL_SELECTION.instanceId,
    model ?? DEFAULT_GROK_MODEL_SELECTION.model,
  );

function mapGrokAcpError(
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

export const makeGrokTextGeneration = Effect.fn("makeGrokTextGeneration")(function* (
  grokSettings: GrokSettings,
  environment: NodeJS.ProcessEnv = process.env,
) {
  const commandSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;

  const runGrokJson = <S extends Schema.Top>({
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
      const resolvedModel = resolveGrokAcpBaseModelId(modelSelection.model);
      const outputRef = yield* Ref.make("");
      const runtime = yield* makeGrokAcpRuntime({
        grokSettings,
        environment,
        childProcessSpawner: commandSpawner,
        cwd,
        clientInfo: { name: "t3-code-git-text", version: "0.0.0" },
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
        yield* applyGrokAcpModelSelection({
          runtime,
          currentModelId: currentGrokModelIdFromSessionSetup(started.sessionSetupResult),
          requestedModelId: resolvedModel,
          mapError: (cause) =>
            mapGrokAcpError(
              operation,
              "Failed to set Grok ACP base model for text generation.",
              cause,
            ),
        });

        return yield* runtime.prompt({
          prompt: [{ type: "text", text: prompt }],
        });
      }).pipe(
        Effect.timeoutOption(GROK_TIMEOUT_MS),
        Effect.flatMap(
          Option.match({
            onNone: () =>
              Effect.fail(
                new TextGenerationError({ operation, detail: "Grok ACP request timed out." }),
              ),
            onSome: (value) => Effect.succeed(value),
          }),
        ),
        Effect.mapError((cause: EffectAcpErrors.AcpError | TextGenerationError) =>
          isTextGenerationError(cause)
            ? cause
            : mapGrokAcpError(operation, "Grok ACP request failed.", cause),
        ),
      );

      const rawResult = (yield* Ref.get(outputRef)).trim();
      if (!rawResult) {
        return yield* new TextGenerationError({
          operation,
          detail:
            promptResult.stopReason === "cancelled"
              ? "Grok ACP request was cancelled."
              : "Grok Agent returned empty output.",
        });
      }

      return yield* Schema.decodeEffect(Schema.fromJsonString(outputSchemaJson))(
        extractJsonObject(rawResult),
      ).pipe(
        Effect.catchTag("SchemaError", (cause) =>
          Effect.fail(
            new TextGenerationError({
              operation,
              detail: "Grok Agent returned invalid structured output.",
              cause,
            }),
          ),
        ),
      );
    }).pipe(
      Effect.mapError((cause) =>
        isTextGenerationError(cause)
          ? cause
          : mapGrokAcpError(operation, "Grok ACP text generation failed.", cause),
      ),
      Effect.scoped,
    );

  const generateCommitMessage: TextGenerationShape["generateCommitMessage"] = Effect.fn(
    "GrokTextGeneration.generateCommitMessage",
  )(function* (input) {
    const { prompt, outputSchema } = buildCommitMessagePrompt({
      branch: input.branch,
      stagedSummary: input.stagedSummary,
      stagedPatch: input.stagedPatch,
      includeBranch: input.includeBranch === true,
    });

    const generated = yield* runGrokJson({
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
    "GrokTextGeneration.generatePrContent",
  )(function* (input) {
    const { prompt, outputSchema } = buildPrContentPrompt({
      baseBranch: input.baseBranch,
      headBranch: input.headBranch,
      commitSummary: input.commitSummary,
      diffSummary: input.diffSummary,
      diffPatch: input.diffPatch,
    });

    const generated = yield* runGrokJson({
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
    "GrokTextGeneration.generateBranchName",
  )(function* (input) {
    const { prompt, outputSchema } = buildBranchNamePrompt({
      message: input.message,
      attachments: input.attachments,
    });

    const generated = yield* runGrokJson({
      operation: "generateBranchName",
      cwd: input.cwd,
      prompt,
      outputSchemaJson: outputSchema,
      modelSelection: resolveInputModelSelection(input.modelSelection, input.model),
    });

    return {
      branch: sanitizeBranchFragment(generated.branch),
    };
  });

  const generateThreadTitle: TextGenerationShape["generateThreadTitle"] = Effect.fn(
    "GrokTextGeneration.generateThreadTitle",
  )(function* (input) {
    const { prompt, outputSchema } = buildThreadTitlePrompt({
      message: input.message,
      attachments: input.attachments,
    });

    const generated = yield* runGrokJson({
      operation: "generateThreadTitle",
      cwd: input.cwd,
      prompt,
      outputSchemaJson: outputSchema,
      modelSelection: resolveInputModelSelection(input.modelSelection, input.model),
    });

    return {
      title: sanitizeThreadTitle(generated.title),
    } satisfies ThreadTitleGenerationResult;
  });

  const generateStructuredJson: TextGenerationShape["generateStructuredJson"] = Effect.fn(
    "GrokTextGeneration.generateStructuredJson",
  )(function* (input) {
    return yield* runGrokJson({
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
