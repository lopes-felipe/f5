import { randomUUID } from "node:crypto";

import { Effect, FileSystem, Layer, Option, Path, Schema, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { resolveInvocationEffect } from "../../spawn/resolveCommand.ts";

import {
  type CodexSettings,
  DEFAULT_GIT_TEXT_GENERATION_MODEL,
  type ModelSelection,
} from "@t3tools/contracts";
import { sanitizeBranchFragment, sanitizeFeatureBranchName } from "@t3tools/shared/git";
import { parseLaunchArgv } from "@t3tools/shared/cliArgs";
import {
  getModelSelectionStringOptionValue,
  resolveCodexReasoningEffortForModel,
} from "@t3tools/shared/model";
import { formatAttachmentMetadata } from "@t3tools/shared/attachmentMetadata";

import { resolveAttachmentPath } from "../../attachmentStore.ts";
import { ServerConfig } from "../../config.ts";
import { prependCodexCliTelemetryDisabledConfig } from "../../provider/codexCliConfig.ts";
import { resolveCodexLaunchArgv } from "../../provider/codexLaunchArgs.ts";
import { buildProviderChildProcessEnv } from "../../providerProcessEnv.ts";
import { resolveCodexHome } from "../../os-jank.ts";
import { sanitizeThreadTitle } from "../../threadTitle.ts";
import { TextGenerationError } from "../Errors.ts";
import {
  buildBranchNamePrompt,
  buildCommitMessagePrompt,
  buildPrContentPrompt,
} from "../Prompts.ts";
import {
  type BranchNameGenerationInput,
  type BranchNameGenerationResult,
  type CommitMessageGenerationResult,
  type PrContentGenerationResult,
  type ThreadTitleGenerationResult,
  type TextGenerationShape,
  TextGeneration,
} from "../Services/TextGeneration.ts";

const DEFAULT_CODEX_REASONING_EFFORT = "low";
const CODEX_TIMEOUT_MS = 180_000;

export function resolveCodexTextGenerationReasoningEffort(
  model: string,
  modelSelection: ModelSelection | undefined,
  reasoningEffort?: string,
): string {
  return resolveCodexReasoningEffortForModel(
    model,
    reasoningEffort ??
      getModelSelectionStringOptionValue(modelSelection, "reasoningEffort") ??
      DEFAULT_CODEX_REASONING_EFFORT,
  );
}

function toCodexOutputJsonSchema(schema: Schema.Top): unknown {
  const document = Schema.toJsonSchemaDocument(schema);
  if (document.definitions && Object.keys(document.definitions).length > 0) {
    return {
      ...document.schema,
      $defs: document.definitions,
    };
  }
  return document.schema;
}

function normalizeCodexError(
  operation: string,
  error: unknown,
  fallback: string,
): TextGenerationError {
  if (Schema.is(TextGenerationError)(error)) {
    return error;
  }

  if (error instanceof Error) {
    const lower = error.message.toLowerCase();
    if (
      error.message.includes("Command not found: codex") ||
      lower.includes("spawn codex") ||
      lower.includes("enoent")
    ) {
      return new TextGenerationError({
        operation,
        detail: "Codex CLI (`codex`) is required but not available on PATH.",
        cause: error,
      });
    }
    return new TextGenerationError({
      operation,
      detail: `${fallback}: ${error.message}`,
      cause: error,
    });
  }

  return new TextGenerationError({
    operation,
    detail: fallback,
    cause: error,
  });
}

function limitSection(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  const truncated = value.slice(0, maxChars);
  return `${truncated}\n\n[truncated]`;
}

function sanitizeCommitSubject(raw: string): string {
  const singleLine = raw.trim().split(/\r?\n/g)[0]?.trim() ?? "";
  const withoutTrailingPeriod = singleLine.replace(/[.]+$/g, "").trim();
  if (withoutTrailingPeriod.length === 0) {
    return "Update project files";
  }

  if (withoutTrailingPeriod.length <= 72) {
    return withoutTrailingPeriod;
  }
  return withoutTrailingPeriod.slice(0, 72).trimEnd();
}

function sanitizePrTitle(raw: string): string {
  const singleLine = raw.trim().split(/\r?\n/g)[0]?.trim() ?? "";
  if (singleLine.length > 0) {
    return singleLine;
  }
  return "Update project changes";
}

export const makeCodexTextGeneration = (
  codexSettings?: Pick<CodexSettings, "binaryPath" | "homePath" | "launchArgs">,
  processEnvironment: NodeJS.ProcessEnv = process.env,
) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const commandSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const serverConfig = yield* Effect.service(ServerConfig);

    type MaterializedImageAttachments = {
      readonly imagePaths: ReadonlyArray<string>;
    };

    const readStreamAsString = <E>(
      operation: string,
      stream: Stream.Stream<Uint8Array, E>,
    ): Effect.Effect<string, TextGenerationError> =>
      Effect.gen(function* () {
        let text = "";
        yield* Stream.runForEach(stream, (chunk) =>
          Effect.sync(() => {
            text += Buffer.from(chunk).toString("utf8");
          }),
        ).pipe(
          Effect.mapError((cause) =>
            normalizeCodexError(operation, cause, "Failed to collect process output"),
          ),
        );
        return text;
      });

    const tempDir = process.env.TMPDIR ?? process.env.TEMP ?? process.env.TMP ?? "/tmp";

    const writeTempFile = (
      operation: string,
      prefix: string,
      content: string,
    ): Effect.Effect<string, TextGenerationError> => {
      const filePath = path.join(tempDir, `t3code-${prefix}-${process.pid}-${randomUUID()}.tmp`);
      return fileSystem.writeFileString(filePath, content).pipe(
        Effect.mapError(
          (cause) =>
            new TextGenerationError({
              operation,
              detail: `Failed to write temp file at ${filePath}.`,
              cause,
            }),
        ),
        Effect.as(filePath),
      );
    };

    const safeUnlink = (filePath: string): Effect.Effect<void, never> =>
      fileSystem.remove(filePath).pipe(Effect.catch(() => Effect.void));

    const materializeImageAttachments = (
      _operation:
        | "generateCommitMessage"
        | "generatePrContent"
        | "generateBranchName"
        | "generateThreadTitle",
      attachments: BranchNameGenerationInput["attachments"],
    ): Effect.Effect<MaterializedImageAttachments, TextGenerationError> =>
      Effect.gen(function* () {
        if (!attachments || attachments.length === 0) {
          return { imagePaths: [] };
        }

        const imagePaths: string[] = [];
        for (const attachment of attachments) {
          if (attachment.type !== "image") {
            continue;
          }

          const resolvedPath = resolveAttachmentPath({
            attachmentsDir: serverConfig.attachmentsDir,
            attachment,
          });
          if (!resolvedPath || !path.isAbsolute(resolvedPath)) {
            continue;
          }
          const fileInfo = yield* fileSystem
            .stat(resolvedPath)
            .pipe(Effect.catch(() => Effect.succeed(null)));
          if (!fileInfo || fileInfo.type !== "File") {
            continue;
          }
          imagePaths.push(resolvedPath);
        }
        return { imagePaths };
      });

    const runCodexJson = <S extends Schema.Top>({
      operation,
      cwd,
      prompt,
      outputSchemaJson,
      model,
      modelSelection,
      reasoningEffort,
      imagePaths = [],
      cleanupPaths = [],
    }: {
      operation: string;
      cwd: string;
      prompt: string;
      outputSchemaJson: S;
      imagePaths?: ReadonlyArray<string>;
      cleanupPaths?: ReadonlyArray<string>;
      model?: string;
      modelSelection?: ModelSelection;
      reasoningEffort?: string;
    }): Effect.Effect<S["Type"], TextGenerationError, S["DecodingServices"]> =>
      Effect.gen(function* () {
        const selectedModel = modelSelection?.model ?? model ?? DEFAULT_GIT_TEXT_GENERATION_MODEL;
        const selectedReasoningEffort = resolveCodexTextGenerationReasoningEffort(
          selectedModel,
          modelSelection,
          reasoningEffort,
        );
        const schemaPath = yield* writeTempFile(
          operation,
          "codex-schema",
          JSON.stringify(toCodexOutputJsonSchema(outputSchemaJson)),
        );
        const outputPath = yield* writeTempFile(operation, "codex-output", "");

        const runCodexCommand = Effect.gen(function* () {
          const codexHomePath = resolveCodexHome({ homePath: codexSettings?.homePath });
          const environment = buildProviderChildProcessEnv(
            processEnvironment,
            codexHomePath ? { CODEX_HOME: codexHomePath } : {},
          );
          const configuredLaunchArgs = parseLaunchArgv(codexSettings?.launchArgs);
          if (!configuredLaunchArgs.ok) {
            return yield* new TextGenerationError({
              operation,
              detail: `Invalid Codex launch arguments: ${configuredLaunchArgs.error}`,
            });
          }
          const launchArgs = yield* Effect.try({
            try: () =>
              resolveCodexLaunchArgv({
                providerLaunchArgs: configuredLaunchArgs.argv,
                environment,
              }),
            catch: (cause) =>
              new TextGenerationError({
                operation,
                detail:
                  cause instanceof Error
                    ? cause.message
                    : "Invalid Codex launch argument configuration.",
                cause,
              }),
          });
          if (launchArgs.dropped.length > 0) {
            yield* Effect.logWarning("ignored reserved Codex text-generation launch arguments", {
              dropped: launchArgs.dropped,
            });
          }
          const args = prependCodexCliTelemetryDisabledConfig([
            ...launchArgs.argv,
            "exec",
            "--ephemeral",
            "--skip-git-repo-check",
            "-s",
            "read-only",
            "--model",
            selectedModel,
            "--config",
            `model_reasoning_effort="${selectedReasoningEffort}"`,
            "--output-schema",
            schemaPath,
            "--output-last-message",
            outputPath,
            ...imagePaths.flatMap((imagePath) => ["--image", imagePath]),
            "-",
          ]);
          const invocation = yield* resolveInvocationEffect(
            codexSettings?.binaryPath || "codex",
            args,
            environment,
            { cwd },
          ).pipe(
            Effect.mapError((cause) =>
              normalizeCodexError(operation, cause, "Failed to resolve Codex CLI process"),
            ),
          );
          const command = ChildProcess.make(invocation.file, [...invocation.args], {
            cwd,
            env: environment,
            stdin: {
              stream: Stream.make(new TextEncoder().encode(prompt)),
            },
          });

          const child = yield* commandSpawner
            .spawn(command)
            .pipe(
              Effect.mapError((cause) =>
                normalizeCodexError(operation, cause, "Failed to spawn Codex CLI process"),
              ),
            );

          const [stdout, stderr, exitCode] = yield* Effect.all(
            [
              readStreamAsString(operation, child.stdout),
              readStreamAsString(operation, child.stderr),
              child.exitCode.pipe(
                Effect.map((value) => Number(value)),
                Effect.mapError((cause) =>
                  normalizeCodexError(operation, cause, "Failed to read Codex CLI exit code"),
                ),
              ),
            ],
            { concurrency: "unbounded" },
          );

          if (exitCode !== 0) {
            const stderrDetail = stderr.trim();
            const stdoutDetail = stdout.trim();
            const detail = stderrDetail.length > 0 ? stderrDetail : stdoutDetail;
            return yield* new TextGenerationError({
              operation,
              detail:
                detail.length > 0
                  ? `Codex CLI command failed: ${detail}`
                  : `Codex CLI command failed with code ${exitCode}.`,
            });
          }
        });

        const cleanup = Effect.all(
          [schemaPath, outputPath, ...cleanupPaths].map((filePath) => safeUnlink(filePath)),
          {
            concurrency: "unbounded",
          },
        ).pipe(Effect.asVoid);

        return yield* Effect.gen(function* () {
          yield* runCodexCommand.pipe(
            Effect.scoped,
            Effect.timeoutOption(CODEX_TIMEOUT_MS),
            Effect.flatMap(
              Option.match({
                onNone: () =>
                  Effect.fail(
                    new TextGenerationError({ operation, detail: "Codex CLI request timed out." }),
                  ),
                onSome: () => Effect.void,
              }),
            ),
          );

          return yield* fileSystem.readFileString(outputPath).pipe(
            Effect.mapError(
              (cause) =>
                new TextGenerationError({
                  operation,
                  detail: "Failed to read Codex output file.",
                  cause,
                }),
            ),
            Effect.flatMap(Schema.decodeEffect(Schema.fromJsonString(outputSchemaJson))),
            Effect.catchTag("SchemaError", (cause) =>
              Effect.fail(
                new TextGenerationError({
                  operation,
                  detail: "Codex returned invalid structured output.",
                  cause,
                }),
              ),
            ),
          );
        }).pipe(Effect.ensuring(cleanup));
      });

    const generateCommitMessage: TextGenerationShape["generateCommitMessage"] = (input) => {
      const { prompt, outputSchema } = buildCommitMessagePrompt({
        branch: input.branch,
        stagedSummary: input.stagedSummary,
        stagedPatch: input.stagedPatch,
        includeBranch: input.includeBranch === true,
        writingPreferences: input.writingPreferences,
      });

      return runCodexJson({
        operation: "generateCommitMessage",
        cwd: input.cwd,
        prompt,
        outputSchemaJson: outputSchema,
        ...(input.model ? { model: input.model } : {}),
        ...(input.modelSelection ? { modelSelection: input.modelSelection } : {}),
      }).pipe(
        Effect.map(
          (generated) =>
            ({
              subject: sanitizeCommitSubject(generated.subject),
              body: generated.body.trim(),
              ...("branch" in generated && typeof generated.branch === "string"
                ? { branch: sanitizeFeatureBranchName(generated.branch) }
                : {}),
            }) satisfies CommitMessageGenerationResult,
        ),
      );
    };

    const generatePrContent: TextGenerationShape["generatePrContent"] = (input) => {
      const { prompt, outputSchema } = buildPrContentPrompt({
        baseBranch: input.baseBranch,
        headBranch: input.headBranch,
        commitSummary: input.commitSummary,
        diffSummary: input.diffSummary,
        diffPatch: input.diffPatch,
        writingPreferences: input.writingPreferences,
      });

      return runCodexJson({
        operation: "generatePrContent",
        cwd: input.cwd,
        prompt,
        outputSchemaJson: outputSchema,
        ...(input.model ? { model: input.model } : {}),
        ...(input.modelSelection ? { modelSelection: input.modelSelection } : {}),
      }).pipe(
        Effect.map(
          (generated) =>
            ({
              title: sanitizePrTitle(generated.title),
              body: generated.body.trim(),
            }) satisfies PrContentGenerationResult,
        ),
      );
    };

    const generateBranchName: TextGenerationShape["generateBranchName"] = (input) => {
      return Effect.gen(function* () {
        const { imagePaths } = yield* materializeImageAttachments(
          "generateBranchName",
          input.attachments,
        );
        const { prompt, outputSchema } = buildBranchNamePrompt({
          message: input.message,
          attachments: input.attachments,
          writingPreferences: input.writingPreferences,
        });

        const generated = yield* runCodexJson({
          operation: "generateBranchName",
          cwd: input.cwd,
          prompt,
          outputSchemaJson: outputSchema,
          imagePaths,
          ...(input.model ? { model: input.model } : {}),
          ...(input.modelSelection ? { modelSelection: input.modelSelection } : {}),
        });

        return {
          branch: sanitizeBranchFragment(generated.branch),
        } satisfies BranchNameGenerationResult;
      });
    };

    const generateThreadTitle: TextGenerationShape["generateThreadTitle"] = (input) =>
      Effect.gen(function* () {
        const { imagePaths } = yield* materializeImageAttachments(
          "generateThreadTitle",
          input.attachments,
        );
        const attachmentLines = formatAttachmentMetadata(
          (input.attachments ?? []).map((attachment) => ({ attachment })),
        );

        const promptSections = [
          "You generate concise thread titles.",
          ...(input.previousTitle !== undefined
            ? [
                "The user requested a new title based on the current contents of this thread.",
                `The previous title was ${JSON.stringify(input.previousTitle)}.`,
                "Return a different title that represents the thread's current state.",
              ]
            : []),
          "Return a JSON object with key: title.",
          "Rules:",
          "- Title must be a short one-line thread title.",
          "- Prefer 2-6 words.",
          "- Describe the user's requested task, not the assistant response.",
          "- No markdown.",
          "- No quotes.",
          "- No trailing punctuation.",
          "- Be specific, but do not copy the full prompt verbatim.",
          "- If images are attached, use them as primary context for visual or UI issues.",
          "",
          input.previousTitle !== undefined ? "Thread contents:" : "User message:",
          limitSection(input.message, 8_000),
        ];
        if (attachmentLines.length > 0) {
          promptSections.push(
            "",
            "Attachment metadata:",
            limitSection(attachmentLines.join("\n"), 4_000),
          );
        }

        const generated = yield* runCodexJson({
          operation: "generateThreadTitle",
          cwd: input.cwd,
          prompt: promptSections.join("\n"),
          outputSchemaJson: Schema.Struct({
            title: Schema.String,
          }),
          ...(input.model ? { model: input.model } : {}),
          ...(input.modelSelection ? { modelSelection: input.modelSelection } : {}),
          imagePaths,
        });

        const title = sanitizeThreadTitle(generated.title);
        if (!title) {
          return yield* new TextGenerationError({
            operation: "generateThreadTitle",
            detail: "Codex returned an empty thread title.",
          });
        }

        return { title } satisfies ThreadTitleGenerationResult;
      });

    const generateStructuredJson: TextGenerationShape["generateStructuredJson"] = (input) =>
      runCodexJson({
        operation: input.operation,
        cwd: input.cwd,
        prompt: input.prompt,
        outputSchemaJson: input.outputSchema,
        ...(input.model ? { model: input.model } : {}),
        ...(input.modelSelection ? { modelSelection: input.modelSelection } : {}),
      });

    return {
      generateCommitMessage,
      generatePrContent,
      generateBranchName,
      generateThreadTitle,
      generateStructuredJson,
    } satisfies TextGenerationShape;
  });

export const CodexTextGenerationLive = Layer.effect(TextGeneration, makeCodexTextGeneration());
