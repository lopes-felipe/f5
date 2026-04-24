import {
  type ChatAttachment,
  DEFAULT_NEW_THREAD_TITLE,
  DEFAULT_THREAD_TITLE_MODEL_BY_PROVIDER,
} from "@t3tools/contracts";
import { Cause, Effect } from "effect";

import type { TextGenerationShape } from "./git/Services/TextGeneration.ts";

export const THREAD_TITLE_MAX_CHARS = 80;
export const CODEX_SPARK_MODEL = "gpt-5.3-codex-spark";

export function trimToMaxChars(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }

  return value.slice(0, maxChars).trimEnd();
}

export function stripWrappingQuotes(value: string): string {
  let normalized = value.trim();
  while (
    (normalized.startsWith('"') && normalized.endsWith('"')) ||
    (normalized.startsWith("'") && normalized.endsWith("'")) ||
    (normalized.startsWith("`") && normalized.endsWith("`"))
  ) {
    normalized = normalized.slice(1, -1).trim();
  }
  return normalized;
}

export function sanitizeThreadTitle(value: string): string {
  const singleLine = value.trim().split(/\r?\n/g)[0]?.trim() ?? "";
  const withoutWrappingQuotes = stripWrappingQuotes(singleLine);
  const withoutTrailingPunctuation = withoutWrappingQuotes.replace(/[.?!,:;]+$/g, "").trim();
  return trimToMaxChars(withoutTrailingPunctuation, THREAD_TITLE_MAX_CHARS)
    .replace(/[.?!,:;]+$/g, "")
    .trim();
}

export function buildFallbackTitle(input: {
  readonly titleSourceText: string;
  readonly attachments: ReadonlyArray<ChatAttachment>;
  readonly defaultTitle: string;
}): string {
  const firstImageName = input.attachments.find((attachment) => attachment.type === "image")?.name;
  const candidates = [input.titleSourceText, firstImageName];
  for (const candidate of candidates) {
    if (typeof candidate !== "string") {
      continue;
    }
    const normalized = sanitizeThreadTitle(candidate);
    if (normalized.length > 0) {
      return normalized;
    }
  }

  return input.defaultTitle;
}

export function buildFallbackThreadTitle(input: {
  readonly titleSourceText: string;
  readonly attachments: ReadonlyArray<ChatAttachment>;
}): string {
  return buildFallbackTitle({
    ...input,
    defaultTitle: DEFAULT_NEW_THREAD_TITLE,
  });
}

export function isUnsupportedCodexSparkModelError(reason: string): boolean {
  const normalized = reason.toLowerCase();
  return (
    normalized.includes(CODEX_SPARK_MODEL) &&
    normalized.includes("not supported") &&
    normalized.includes("chatgpt account")
  );
}

export const resolveBestEffortGeneratedTitle = (input: {
  readonly cwd: string | null | undefined;
  readonly titleSourceText: string;
  readonly attachments: ReadonlyArray<ChatAttachment>;
  readonly titleGenerationModel?: string | undefined;
  readonly defaultTitle: string;
  readonly textGeneration: TextGenerationShape;
  readonly logPrefix: string;
  readonly logContext?: Record<string, unknown>;
}) =>
  Effect.gen(function* () {
    const fallbackTitle = buildFallbackTitle({
      titleSourceText: input.titleSourceText,
      attachments: input.attachments,
      defaultTitle: input.defaultTitle,
    });

    if (!input.cwd) {
      yield* Effect.logWarning(
        `${input.logPrefix} could not resolve cwd for title generation; applying fallback title`,
        input.logContext ?? {},
      );
      return fallbackTitle;
    }

    const cwd = input.cwd;
    const requestedModel =
      input.titleGenerationModel ?? DEFAULT_THREAD_TITLE_MODEL_BY_PROVIDER.codex;
    const generateTitle = (model: string) =>
      input.textGeneration.generateThreadTitle({
        cwd,
        message: input.titleSourceText,
        ...(input.attachments.length > 0 ? { attachments: input.attachments } : {}),
        model,
      });

    let generatedResult = yield* Effect.exit(generateTitle(requestedModel));

    if (generatedResult._tag === "Failure" && requestedModel === CODEX_SPARK_MODEL) {
      const reason = Cause.pretty(generatedResult.cause);
      if (isUnsupportedCodexSparkModelError(reason)) {
        yield* Effect.logInfo(
          `${input.logPrefix} retrying title generation with default model after unsupported spark model`,
          {
            ...input.logContext,
            cwd: input.cwd,
            requestedModel,
            fallbackModel: DEFAULT_THREAD_TITLE_MODEL_BY_PROVIDER.codex,
          },
        );
        generatedResult = yield* Effect.exit(
          generateTitle(DEFAULT_THREAD_TITLE_MODEL_BY_PROVIDER.codex),
        );
      }
    }

    if (generatedResult._tag === "Success") {
      return generatedResult.value.title;
    }

    yield* Effect.logWarning(
      `${input.logPrefix} failed to generate title; applying fallback title`,
      {
        ...input.logContext,
        cwd: input.cwd,
        reason: Cause.pretty(generatedResult.cause),
      },
    );
    return fallbackTitle;
  });
