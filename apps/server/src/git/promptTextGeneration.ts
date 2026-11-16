import type { ModelSelection } from "@t3tools/contracts";
import { sanitizeBranchFragment, sanitizeFeatureBranchName } from "@t3tools/shared/git";
import { Effect, type Schema } from "effect";
import type { TextGenerationError } from "./Errors.ts";
import {
  buildBranchNamePrompt,
  buildCommitMessagePrompt,
  buildPrContentPrompt,
  buildThreadTitlePrompt,
} from "./Prompts.ts";
import type {
  TextGenerationShape,
  ThreadTitleGenerationResult,
} from "./Services/TextGeneration.ts";
import { sanitizeCommitSubject, sanitizePrTitle, sanitizeThreadTitle } from "./Utils.ts";

export type StructuredTextRunner = <S extends Schema.Top>(input: {
  readonly operation: string;
  readonly cwd: string;
  readonly prompt: string;
  readonly outputSchemaJson: S;
  readonly modelSelection: ModelSelection | undefined;
  readonly model: string | undefined;
}) => Effect.Effect<S["Type"], TextGenerationError, S["DecodingServices"]>;

/** Shared source-control prompts, output validation contracts and presentation normalization. */
export function makePromptTextGeneration(runJson: StructuredTextRunner): TextGenerationShape {
  const generateCommitMessage: TextGenerationShape["generateCommitMessage"] = Effect.fn(
    "TextGeneration.generateCommitMessage",
  )(function* (input) {
    const { prompt, outputSchema } = buildCommitMessagePrompt({
      repositoryContext: input.repositoryContext,
      branch: input.branch,
      stagedSummary: input.stagedSummary,
      stagedPatch: input.stagedPatch,
      includeBranch: input.includeBranch === true,
      writingPreferences: input.writingPreferences,
    });
    const generated = yield* runJson({
      operation: "generateCommitMessage",
      cwd: input.cwd,
      prompt,
      outputSchemaJson: outputSchema,
      modelSelection: input.modelSelection,
      model: input.model,
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
    "TextGeneration.generatePrContent",
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
    const generated = yield* runJson({
      operation: "generatePrContent",
      cwd: input.cwd,
      prompt,
      outputSchemaJson: outputSchema,
      modelSelection: input.modelSelection,
      model: input.model,
    });
    return { title: sanitizePrTitle(generated.title), body: generated.body.trim() };
  });

  const generateBranchName: TextGenerationShape["generateBranchName"] = Effect.fn(
    "TextGeneration.generateBranchName",
  )(function* (input) {
    const { prompt, outputSchema } = buildBranchNamePrompt({
      message: input.message,
      attachments: input.attachments,
      writingPreferences: input.writingPreferences,
    });
    const generated = yield* runJson({
      operation: "generateBranchName",
      cwd: input.cwd,
      prompt,
      outputSchemaJson: outputSchema,
      modelSelection: input.modelSelection,
      model: input.model,
    });
    return { branch: sanitizeBranchFragment(generated.branch) };
  });

  const generateThreadTitle: TextGenerationShape["generateThreadTitle"] = Effect.fn(
    "TextGeneration.generateThreadTitle",
  )(function* (input) {
    const { prompt, outputSchema } = buildThreadTitlePrompt(input);
    const generated = yield* runJson({
      operation: "generateThreadTitle",
      cwd: input.cwd,
      prompt,
      outputSchemaJson: outputSchema,
      modelSelection: input.modelSelection,
      model: input.model,
    });
    return {
      ...(generated.needsRefinement !== undefined
        ? { needsRefinement: generated.needsRefinement }
        : {}),
      title: sanitizeThreadTitle(generated.title),
    } satisfies ThreadTitleGenerationResult;
  });

  const generateStructuredJson: TextGenerationShape["generateStructuredJson"] = Effect.fn(
    "TextGeneration.generateStructuredJson",
  )(function* (input) {
    return yield* runJson({
      operation: input.operation,
      cwd: input.cwd,
      prompt: input.prompt,
      outputSchemaJson: input.outputSchema,
      modelSelection: input.modelSelection,
      model: input.model,
    });
  });

  return {
    generateCommitMessage,
    generatePrContent,
    generateBranchName,
    generateThreadTitle,
    generateStructuredJson,
  } satisfies TextGenerationShape;
}
