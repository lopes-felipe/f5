import {
  type ChatAttachment,
  DEFAULT_GIT_TEXT_GENERATION_MODEL_BY_PROVIDER,
  DEFAULT_NEW_THREAD_TITLE,
  DEFAULT_THREAD_TITLE_MODEL_BY_PROVIDER,
  type ModelSelection,
  type OrchestrationMessage,
} from "@t3tools/contracts";
import { Cause, Effect } from "effect";

import type { TextGenerationShape } from "./git/Services/TextGeneration.ts";

export const THREAD_TITLE_MAX_CHARS = 80;
export const THREAD_TITLE_REGENERATION_RECENT_USER_MESSAGE_COUNT = 4;
export const THREAD_TITLE_REGENERATION_MAX_CONTEXT_CHARS = 12_000;
const THREAD_TITLE_CONTEXT_TRUNCATION_MARKER = "\n\n[… earlier thread context truncated …]\n\n";

export function formatThreadTitleRegenerationContext(
  messages: ReadonlyArray<OrchestrationMessage>,
): { readonly text: string; readonly attachments: ReadonlyArray<ChatAttachment> } {
  const userMessages = messages.filter(
    (message) =>
      message.role === "user" &&
      (message.text.trim().length > 0 || (message.attachments?.length ?? 0) > 0),
  );
  const first = userMessages[0];
  if (!first) return { text: "", attachments: [] };

  const recent = userMessages.slice(1).slice(-THREAD_TITLE_REGENERATION_RECENT_USER_MESSAGE_COUNT);
  const selected = [first, ...recent];
  const sections = selected.map((message, index) => {
    const label = index === 0 ? "First user message" : `Recent user message ${index}`;
    return `${label}:\n${message.text.trim() || "[Image attachment without text]"}`;
  });
  const text = sections.join("\n\n");
  const boundedText =
    text.length <= THREAD_TITLE_REGENERATION_MAX_CONTEXT_CHARS
      ? text
      : (() => {
          const firstBudget = Math.min(4_000, sections[0]?.length ?? 0);
          const firstSection = sections[0]?.slice(0, firstBudget).trimEnd() ?? "";
          if (sections.length === 1) {
            const tailBudget =
              THREAD_TITLE_REGENERATION_MAX_CONTEXT_CHARS -
              firstSection.length -
              THREAD_TITLE_CONTEXT_TRUNCATION_MARKER.length;
            return `${firstSection}${THREAD_TITLE_CONTEXT_TRUNCATION_MARKER}${sections[0]!
              .slice(-tailBudget)
              .trimStart()}`;
          }
          const recentBudget =
            THREAD_TITLE_REGENERATION_MAX_CONTEXT_CHARS -
            firstSection.length -
            THREAD_TITLE_CONTEXT_TRUNCATION_MARKER.length -
            (sections.length - 2) * 2;
          const perRecentBudget = Math.floor(recentBudget / (sections.length - 1));
          const recentSections = sections
            .slice(1)
            .map((section) => section.slice(0, perRecentBudget).trimEnd());
          return `${firstSection}${THREAD_TITLE_CONTEXT_TRUNCATION_MARKER}${recentSections.join("\n\n")}`;
        })();
  const attachmentsById = new Map<string, ChatAttachment>();
  for (const message of selected) {
    for (const attachment of message.attachments ?? []) {
      attachmentsById.set(attachment.id, attachment);
    }
  }
  return { text: boundedText, attachments: [...attachmentsById.values()] };
}

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

export function isUnsupportedCodexChatGptModelError(reason: string): boolean {
  const normalized = reason.toLowerCase();
  return (
    normalized.includes("model") &&
    normalized.includes("not supported") &&
    normalized.includes("chatgpt account")
  );
}

export const resolveBestEffortGeneratedTitle = (input: {
  readonly cwd: string | null | undefined;
  readonly titleSourceText: string;
  readonly attachments: ReadonlyArray<ChatAttachment>;
  readonly titleGenerationModel?: string | undefined;
  readonly titleGenerationModelSelection?: ModelSelection | undefined;
  readonly previousTitle?: string | undefined;
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
    const requestedModelSelection = input.titleGenerationModelSelection;
    const requestedModel =
      requestedModelSelection?.model ??
      input.titleGenerationModel ??
      DEFAULT_THREAD_TITLE_MODEL_BY_PROVIDER.codex;
    const generateTitle = (model: string) =>
      input.textGeneration.generateThreadTitle({
        cwd,
        message: input.titleSourceText,
        ...(input.previousTitle !== undefined ? { previousTitle: input.previousTitle } : {}),
        ...(input.attachments.length > 0 ? { attachments: input.attachments } : {}),
        model,
        ...(requestedModelSelection
          ? {
              modelSelection:
                requestedModelSelection.model === model
                  ? requestedModelSelection
                  : { ...requestedModelSelection, model },
            }
          : {}),
      });

    let generatedResult = yield* Effect.exit(generateTitle(requestedModel));

    const fallbackModel = DEFAULT_GIT_TEXT_GENERATION_MODEL_BY_PROVIDER.codex;
    if (generatedResult._tag === "Failure" && requestedModel !== fallbackModel) {
      const reason = Cause.pretty(generatedResult.cause);
      if (isUnsupportedCodexChatGptModelError(reason)) {
        yield* Effect.logInfo(
          `${input.logPrefix} retrying title generation with fallback model after unsupported ChatGPT Codex model`,
          {
            ...input.logContext,
            cwd: input.cwd,
            requestedModel,
            fallbackModel,
          },
        );
        generatedResult = yield* Effect.exit(generateTitle(fallbackModel));
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
