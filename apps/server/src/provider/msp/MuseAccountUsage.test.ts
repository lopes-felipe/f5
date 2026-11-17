import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import * as Semaphore from "effect/Semaphore";
import { ProviderInstanceId } from "@t3tools/contracts";
import { makeMuseAccountUsage } from "./MuseAccountUsage";

describe("Muse account-wide reports", () => {
  it("separates accounts when only the API key changes", async () => {
    const make = (key: string) =>
      Effect.runPromise(
        makeMuseAccountUsage({
          instanceId: ProviderInstanceId.make("same"),
          displayName: "Muse",
          enabled: true,
          environment: { META_API_KEY: key },
        }),
      );
    const first = await make("key-a");
    const second = await make("key-b");
    expect(first.capability.identity).not.toBe(second.capability.identity);
    expect(
      (await Effect.runPromise(second.capability.getSnapshot)).sections[0]?.snapshot,
    ).toBeNull();
  });
  it("publishes limits and tier, ignores older reports, and clears an omitted tier", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const { capability, publish } = yield* makeMuseAccountUsage({
          instanceId: ProviderInstanceId.make("muse"),
          displayName: "Muse",
          enabled: true,
          environment: {},
        });
        const permits = yield* Semaphore.make(1);
        expect((yield* capability.getSnapshot).sections[0]?.snapshot).toBeNull();
        const report = {
          observedAtMs: 1000,
          tier: " Pro ",
          window: { usedPercent: 110, resetsAtMs: 5000, windowDurationMins: 300 },
          weekly: { usedPercent: 15, resetsAtMs: 10000 },
        };
        yield* publish(report);
        yield* publish({ ...report, observedAtMs: 900, tier: "Old" });
        const result = yield* capability.refreshAccount!(permits);
        expect(result.fresh).toBe(true);
        expect(result.snapshot.sections[0]?.snapshot?.data).toMatchObject({
          plan: "Pro",
          windows: [
            { id: "session", usedPercent: 100 },
            { id: "weekly", usedPercent: 15 },
          ],
        });
        expect((yield* capability.refreshAccount!(permits)).fresh).toBe(false);
        yield* publish({ ...report, observedAtMs: 1001, tier: "" });
        expect((yield* capability.getSnapshot).sections[0]?.snapshot?.data).not.toHaveProperty(
          "plan",
        );
      }),
    );
  });
});
