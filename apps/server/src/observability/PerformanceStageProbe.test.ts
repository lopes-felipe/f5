import { Effect } from "effect";
import { expect, it } from "vitest";
import { measurePerformanceStage } from "./Metrics";

it("keeps a throwing diagnostics probe from changing success or failure", async () => {
  const probe = () => {
    throw new Error("probe failed");
  };
  await expect(
    Effect.runPromise(measurePerformanceStage(probe, "fixture", Effect.succeed(42))),
  ).resolves.toBe(42);
  const exit = await Effect.runPromise(
    Effect.exit(measurePerformanceStage(probe, "fixture", Effect.fail("original failure"))),
  );
  expect(exit._tag).toBe("Failure");
  expect(JSON.stringify(exit)).toContain("original failure");
  expect(JSON.stringify(exit)).not.toContain("probe failed");
});
