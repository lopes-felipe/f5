import { describe, expect, it, vi } from "vitest";
import { Effect } from "effect";
import {
  DEFAULT_GIT_TEXT_GENERATION_MODEL_BY_PROVIDER,
  MessageId,
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  ProviderInstanceId,
  type OrchestrationMessage,
} from "@t3tools/contracts";

import { TextGenerationError } from "./git/Errors.ts";
import {
  buildFallbackTitle,
  buildFallbackThreadTitle,
  formatThreadTitleRegenerationContext,
  isUnsupportedCodexChatGptModelError,
  resolveBestEffortGeneratedTitle,
  sanitizeThreadTitle,
  stripWrappingQuotes,
  THREAD_TITLE_MAX_CHARS,
  THREAD_TITLE_REGENERATION_MAX_CONTEXT_CHARS,
  trimToMaxChars,
} from "./threadTitle.ts";

describe("trimToMaxChars", () => {
  it("returns the original value when already within the limit", () => {
    expect(trimToMaxChars("short", 10)).toBe("short");
  });

  it("trims overly long values and removes trailing whitespace", () => {
    expect(trimToMaxChars("1234567890   ", 10)).toBe("1234567890");
  });
});

describe("stripWrappingQuotes", () => {
  it("removes matching surrounding quotes and backticks", () => {
    expect(stripWrappingQuotes(' "title" ')).toBe("title");
    expect(stripWrappingQuotes("`title`")).toBe("title");
  });
});

describe("sanitizeThreadTitle", () => {
  it("keeps only the first line and strips wrapping quotes and trailing punctuation", () => {
    expect(sanitizeThreadTitle(' "Fix sidebar layout."\nignore me')).toBe("Fix sidebar layout");
  });

  it("caps titles to the shared maximum length", () => {
    const raw = `  ${"a".repeat(THREAD_TITLE_MAX_CHARS + 5)}  `;
    expect(sanitizeThreadTitle(raw)).toHaveLength(THREAD_TITLE_MAX_CHARS);
  });
});

describe("buildFallbackThreadTitle", () => {
  it("uses the sanitized text when present", () => {
    expect(
      buildFallbackThreadTitle({
        titleSourceText: "  Fix oversized drawer.  ",
        attachments: [],
      }),
    ).toBe("Fix oversized drawer");
  });

  it("falls back to the first image name when the text is empty", () => {
    expect(
      buildFallbackThreadTitle({
        titleSourceText: "   ",
        attachments: [
          {
            type: "image",
            id: "att-1",
            name: "mockup-final.png",
            mimeType: "image/png",
            sizeBytes: 42,
          },
        ],
      }),
    ).toBe("mockup-final.png");
  });

  it("falls back to the default placeholder when no text or images are available", () => {
    expect(
      buildFallbackThreadTitle({
        titleSourceText: "   ",
        attachments: [],
      }),
    ).toBe("New thread");
  });
});

describe("buildFallbackTitle", () => {
  it("uses the provided default title when no text or image name is available", () => {
    expect(
      buildFallbackTitle({
        titleSourceText: "   ",
        attachments: [],
        defaultTitle: "New workflow",
      }),
    ).toBe("New workflow");
  });
});

describe("formatThreadTitleRegenerationContext", () => {
  const userMessage = (index: number, text: string): OrchestrationMessage => ({
    id: MessageId.makeUnsafe(`message-${index}`),
    role: "user",
    text,
    turnId: null,
    streaming: false,
    createdAt: `2026-08-15T09:0${index}:00.000Z`,
    updatedAt: `2026-08-15T09:0${index}:00.000Z`,
  });

  it("uses the first and four most recent user messages", () => {
    const context = formatThreadTitleRegenerationContext(
      Array.from({ length: 7 }, (_, index) => userMessage(index + 1, `request ${index + 1}`)),
    );
    expect(context.text).toContain("request 1");
    expect(context.text).not.toContain("request 2");
    expect(context.text).not.toContain("request 3");
    expect(context.text).toContain("request 4");
    expect(context.text).toContain("request 7");
  });

  it("preserves the beginning and latest context within the fixed budget", () => {
    const context = formatThreadTitleRegenerationContext([
      userMessage(1, `first-${"a".repeat(8_000)}`),
      userMessage(2, `latest-${"z".repeat(8_000)}`),
    ]);
    expect(context.text.length).toBeLessThanOrEqual(THREAD_TITLE_REGENERATION_MAX_CONTEXT_CHARS);
    expect(context.text).toContain("first-");
    expect(context.text).toContain("latest-");
    expect(context.text).toContain("truncated");
  });

  it("caps and deduplicates title attachments while retaining recent context", () => {
    const messages = Array.from({ length: 5 }, (_, messageIndex) => ({
      ...userMessage(messageIndex + 1, `request ${messageIndex + 1}`),
      attachments: Array.from({ length: PROVIDER_SEND_TURN_MAX_ATTACHMENTS }, (_, imageIndex) => ({
        type: "image" as const,
        id: `image-${messageIndex}-${imageIndex}`,
        name: `image-${messageIndex}-${imageIndex}.png`,
        mimeType: "image/png",
        sizeBytes: 100,
      })),
    }));

    const context = formatThreadTitleRegenerationContext(messages);

    expect(context.attachments).toHaveLength(PROVIDER_SEND_TURN_MAX_ATTACHMENTS);
    expect(context.attachments.some((attachment) => attachment.id === "image-4-0")).toBe(true);
    expect(context.attachments[0]?.id).toBe("image-0-0");
  });
});

describe("isUnsupportedCodexChatGptModelError", () => {
  it("matches unsupported ChatGPT Codex model errors", () => {
    expect(
      isUnsupportedCodexChatGptModelError(
        "The 'gpt-5.3-codex' model is not supported when using Codex with a ChatGPT account.",
      ),
    ).toBe(true);
  });

  it("does not match unrelated ChatGPT account capability errors", () => {
    expect(
      isUnsupportedCodexChatGptModelError(
        "This operation is not supported when using Codex with a ChatGPT account.",
      ),
    ).toBe(false);
  });
});

describe("resolveBestEffortGeneratedTitle", () => {
  it("passes the explicit title-generation model selection to text generation", async () => {
    const titleGenerationModelSelection = {
      instanceId: ProviderInstanceId.make("codex_personal"),
      model: "custom/title-model",
    };
    const generateThreadTitle = vi.fn(() => Effect.succeed({ title: "Selected title" }));

    const title = await Effect.runPromise(
      resolveBestEffortGeneratedTitle({
        cwd: "/tmp/project",
        titleSourceText: "Plan title generation routing",
        attachments: [],
        titleGenerationModel: "ignored/title-model",
        titleGenerationModelSelection,
        defaultTitle: "New workflow",
        textGeneration: {
          generateCommitMessage: () => Effect.die("unsupported"),
          generatePrContent: () => Effect.die("unsupported"),
          generateBranchName: () => Effect.die("unsupported"),
          generateThreadTitle,
          generateStructuredJson: () => Effect.die("unsupported"),
        },
        logPrefix: "threadTitle test",
      }),
    );

    expect(title).toBe("Selected title");
    expect(generateThreadTitle).toHaveBeenCalledWith(
      expect.objectContaining({
        cwd: "/tmp/project",
        message: "Plan title generation routing",
        model: "custom/title-model",
        modelSelection: titleGenerationModelSelection,
      }),
    );
  });

  it("retries unsupported ChatGPT Codex title models with the fallback text-generation model", async () => {
    const titleGenerationModelSelection = {
      instanceId: ProviderInstanceId.make("codex_personal"),
      model: "gpt-5.3-codex",
    };
    const generateThreadTitle = vi
      .fn()
      .mockImplementationOnce(() =>
        Effect.fail(
          new Error(
            "The 'gpt-5.3-codex' model is not supported when using Codex with a ChatGPT account.",
          ),
        ),
      )
      .mockImplementationOnce(() => Effect.succeed({ title: "Retry succeeded" }));

    const title = await Effect.runPromise(
      resolveBestEffortGeneratedTitle({
        cwd: "/tmp/project",
        titleSourceText: "Plan the workflow",
        attachments: [],
        titleGenerationModel: "ignored-by-selection",
        titleGenerationModelSelection,
        defaultTitle: "New workflow",
        textGeneration: {
          generateCommitMessage: () => Effect.die("unsupported"),
          generatePrContent: () => Effect.die("unsupported"),
          generateBranchName: () => Effect.die("unsupported"),
          generateThreadTitle,
          generateStructuredJson: () => Effect.die("unsupported"),
        },
        logPrefix: "threadTitle test",
        logContext: { workflowId: "workflow-1" },
      }),
    );

    expect(title).toBe("Retry succeeded");
    expect(generateThreadTitle).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        cwd: "/tmp/project",
        message: "Plan the workflow",
        model: "gpt-5.3-codex",
        modelSelection: titleGenerationModelSelection,
      }),
    );
    const expectedFallbackSelection = {
      ...titleGenerationModelSelection,
      model: DEFAULT_GIT_TEXT_GENERATION_MODEL_BY_PROVIDER.codex,
    };
    expect(generateThreadTitle).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        cwd: "/tmp/project",
        message: "Plan the workflow",
        model: DEFAULT_GIT_TEXT_GENERATION_MODEL_BY_PROVIDER.codex,
        modelSelection: expectedFallbackSelection,
      }),
    );
  });

  it("falls back to the deterministic title when generation fails", async () => {
    const title = await Effect.runPromise(
      resolveBestEffortGeneratedTitle({
        cwd: "/tmp/project",
        titleSourceText: "  Fix the workflow title generation.  ",
        attachments: [],
        titleGenerationModel: "custom/title-model",
        defaultTitle: "New workflow",
        textGeneration: {
          generateCommitMessage: () => Effect.die("unsupported"),
          generatePrContent: () => Effect.die("unsupported"),
          generateBranchName: () => Effect.die("unsupported"),
          generateThreadTitle: () =>
            Effect.fail(
              new TextGenerationError({
                operation: "generateThreadTitle",
                detail: "simulated failure",
              }),
            ),
          generateStructuredJson: () => Effect.die("unsupported"),
        },
        logPrefix: "threadTitle test",
      }),
    );

    expect(title).toBe("Fix the workflow title generation");
  });
});
