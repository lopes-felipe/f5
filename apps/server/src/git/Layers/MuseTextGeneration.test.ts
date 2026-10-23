import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, Schema } from "effect";
import { expect, it } from "vitest";
import { makeMuseTextGeneration, type MusePromptRunner } from "./MuseTextGeneration.ts";

it("preserves Muse's models, prompts and normalization through the shared generation factory", async () => {
  const calls: Parameters<MusePromptRunner>[0][] = [];
  const values = [
    { subject: "fix: bound queues", body: "  Keep memory bounded.  ", branch: "Feature/Pi queues" },
    { title: "  Bound Pi queues  ", body: "  Retain reliable delivery.  " },
    { branch: "Feature/Pi queues" },
    { title: "  Review Pi transport  ", needsRefinement: false },
    { count: 3 },
  ];
  await Effect.runPromise(
    Effect.gen(function* () {
      const service = yield* makeMuseTextGeneration(
        { enabled: true, binaryPath: "muse", customModels: [] },
        {},
        {
          runPrompt: (input) =>
            Effect.sync(() => {
              calls.push(input);
              return JSON.stringify(values.shift());
            }),
        },
      );
      const commit = yield* service.generateCommitMessage({
        cwd: "/checkout",
        branch: "feature",
        stagedSummary: "one file",
        stagedPatch: "+bounded",
        includeBranch: true,
        model: "chosen-model",
      });
      expect(commit).toMatchObject({ subject: "fix: bound queues", body: "Keep memory bounded." });
      expect(commit.branch).toBeTruthy();
      expect(
        yield* service.generatePrContent({
          cwd: "/checkout",
          baseBranch: "main",
          headBranch: "feature",
          commitSummary: "bound queues",
          diffSummary: "one file",
          diffPatch: "+bounded",
        }),
      ).toEqual({ title: "Bound Pi queues", body: "Retain reliable delivery." });
      expect(
        (yield* service.generateBranchName({ cwd: "/checkout", message: "Bound queues" })).branch,
      ).not.toContain(" ");
      expect(
        yield* service.generateThreadTitle({
          cwd: "/checkout",
          message: "Bound queues",
          linkedContext: "team/repo#42: Fix native transport",
        }),
      ).toEqual({ title: "Review Pi transport", needsRefinement: false });
      expect(
        yield* service.generateStructuredJson({
          cwd: "/checkout",
          operation: "count",
          prompt: "Count queues",
          outputSchema: Schema.Struct({ count: Schema.Number }),
        }),
      ).toEqual({ count: 3 });
    }).pipe(Effect.provide(NodeServices.layer)),
  );
  expect(calls).toHaveLength(5);
  expect(calls.every((call) => call.cwd === "/checkout")).toBe(true);
  expect(calls[0]?.modelId).toBe("chosen-model");
  expect(calls[0]?.prompt).toContain("+bounded");
  expect(calls[1]?.modelId).toBe("muse-spark-1.3");
  expect(calls[3]?.prompt).toContain("team/repo#42: Fix native transport");
});
