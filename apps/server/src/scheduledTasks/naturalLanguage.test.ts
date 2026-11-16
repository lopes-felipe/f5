import { it } from "@effect/vitest";
import { expect } from "vitest";
import { Effect, Fiber } from "effect";
import { TestClock } from "effect/testing";
import { ProviderInstanceId } from "@t3tools/contracts";
import type { TextGenerationShape } from "../git/Services/TextGeneration.ts";
import { TextGenerationError } from "../git/Errors.ts";
import { parseNaturalLanguageSchedule } from "./naturalLanguage.ts";
const input = {
  preview: {
    timezone: "America/New_York",
    schedule: { kind: "natural_language" as const, text: "first Monday at 14:30" },
  },
  now: new Date("2026-01-01T00:00:00Z"),
  cwd: "/repo",
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "mini" },
  isCodex: true,
};
const generation = (value: unknown) =>
  ({ generateStructuredJson: () => Effect.succeed(value) }) as unknown as TextGenerationShape;
it.effect("derives the summary and five fires from validated cron", () =>
  Effect.gen(function* () {
    const result = yield* parseNaturalLanguageSchedule({
      ...input,
      textGeneration: generation({ kind: "recurring", cron: "30 14 * * MON#1" }),
    });
    expect(result.nextFireTimes).toHaveLength(5);
    expect(result.nextFireTimes[0]).toBe("2026-01-05T19:30:00.000Z");
    expect(result.summary).toContain("America/New_York");
  }),
);
it.effect("binds a one-shot to its explicit year", () =>
  Effect.gen(function* () {
    const result = yield* parseNaturalLanguageSchedule({
      ...input,
      textGeneration: generation({ kind: "once", instant: "2026-01-02T20:00:00Z" }),
    });
    expect(result.cron).toBe("0 0 15 2 1 * 2026");
    expect(result.nextFireTimes).toHaveLength(1);
    expect(result.oneShotAt).toBe("2026-01-02T20:00:00.000Z");
  }),
);
for (const value of [
  { kind: "recurring", cron: "* * * * * *" },
  { kind: "once", instant: "2025-01-01T00:00:00Z" },
  { kind: "once", instant: "2026-11-01T05:30:00Z" },
])
  it.effect(`rejects invalid or ambiguous model output ${JSON.stringify(value)}`, () =>
    Effect.gen(function* () {
      expect(
        (yield* Effect.result(
          parseNaturalLanguageSchedule({ ...input, textGeneration: generation(value) }),
        ))._tag,
      ).toBe("Failure");
    }),
  );
it.effect("times out through the fake clock and leaves fallback editors available", () =>
  Effect.gen(function* () {
    const operation = parseNaturalLanguageSchedule({
      ...input,
      textGeneration: {
        generateStructuredJson: () => Effect.never,
      } as unknown as TextGenerationShape,
    });
    const fiber = yield* Effect.result(operation).pipe(Effect.forkChild);
    yield* TestClock.adjust("30 seconds");
    const result = yield* Fiber.join(fiber);
    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure") expect(result.failure.code).toBe("natural_language_unavailable");
  }),
);
it.effect("retries only the narrow unsupported Codex model case", () =>
  Effect.gen(function* () {
    const models: string[] = [];
    const textGeneration = {
      generateStructuredJson: ({ modelSelection }: { modelSelection: { model: string } }) => {
        models.push(modelSelection.model);
        return models.length === 1
          ? Effect.fail(
              new TextGenerationError({
                operation: "schedule",
                detail: "The model 'mini' is not supported when using Codex with a ChatGPT account",
              }),
            )
          : Effect.succeed({ kind: "recurring", cron: "0 9 * * 1-5" });
      },
    } as unknown as TextGenerationShape;
    yield* parseNaturalLanguageSchedule({ ...input, textGeneration });
    expect(models).toHaveLength(2);
    expect(models[1]).not.toBe("mini");
  }),
);
