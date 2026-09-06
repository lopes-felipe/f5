import { assert, it } from "@effect/vitest";
import { Effect } from "effect";
import { recheckUnknownMergeStates } from "./mergeState.ts";

it.effect("rechecks at 5/15/30 seconds and rejects changes to either revision", () =>
  Effect.gen(function* () {
    const candidate = { id: "pr", headRefOid: "head", baseRefOid: "base" };
    const delays: number[] = [];
    let attempt = 0;
    const result = yield* recheckUnknownMergeStates(
      [candidate],
      () => {
        attempt++;
        return Effect.succeed({
          data: {
            nodes: [
              {
                ...candidate,
                mergeable: attempt < 3 ? "UNKNOWN" : "MERGEABLE",
                mergeStateStatus: attempt < 3 ? "UNKNOWN" : "CLEAN",
              },
            ],
          },
        });
      },
      (delay) =>
        Effect.sync(() => {
          delays.push(delay);
        }),
    );
    assert.deepStrictEqual(delays, [5000, 10000, 15000]);
    assert.equal(result.get("pr")?.mergeStateStatus, "CLEAN");
    const changed = yield* recheckUnknownMergeStates(
      [candidate],
      () =>
        Effect.succeed({
          data: {
            nodes: [
              {
                ...candidate,
                baseRefOid: "moved",
                mergeable: "MERGEABLE",
                mergeStateStatus: "CLEAN",
              },
            ],
          },
        }),
      () => Effect.void,
    );
    assert.equal(changed.size, 0);
  }),
);
