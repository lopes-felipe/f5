import { describe, expect, it, vi } from "vitest";
import { Effect } from "effect";

import { TextGenerationError } from "./git/Errors.ts";
import {
  CODEX_SPARK_MODEL,
  buildFallbackTitle,
  buildFallbackThreadTitle,
  resolveBestEffortGeneratedTitle,
  sanitizeThreadTitle,
  stripWrappingQuotes,
  THREAD_TITLE_MAX_CHARS,
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

describe("resolveBestEffortGeneratedTitle", () => {
  it("retries unsupported spark models with the default codex title model", async () => {
    const generateThreadTitle = vi
      .fn()
      .mockImplementationOnce(() =>
        Effect.fail(
          new Error(
            "The 'gpt-5.3-codex-spark' model is not supported when using Codex with a ChatGPT account.",
          ),
        ),
      )
      .mockImplementationOnce(() => Effect.succeed({ title: "Retry succeeded" }));

    const title = await Effect.runPromise(
      resolveBestEffortGeneratedTitle({
        cwd: "/tmp/project",
        titleSourceText: "Plan the workflow",
        attachments: [],
        titleGenerationModel: CODEX_SPARK_MODEL,
        defaultTitle: "New workflow",
        textGeneration: {
          generateCommitMessage: () => Effect.die("unsupported"),
          generatePrContent: () => Effect.die("unsupported"),
          generateBranchName: () => Effect.die("unsupported"),
          generateThreadTitle,
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
        model: CODEX_SPARK_MODEL,
      }),
    );
    expect(generateThreadTitle).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        cwd: "/tmp/project",
        message: "Plan the workflow",
        model: "gpt-5.3-codex",
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
        },
        logPrefix: "threadTitle test",
      }),
    );

    expect(title).toBe("Fix the workflow title generation");
  });
});
