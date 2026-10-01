import { ThreadId } from "@t3tools/contracts";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { makeWorktreeSetupGate } from "./WorktreeSetupGate.ts";

const threadId = ThreadId.makeUnsafe("thread-gate");

describe("WorktreeSetupGate", () => {
  it("gates while registered, opens on handoff and reports orphaned durable tokens", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const gate = yield* makeWorktreeSetupGate;
        const states: string[] = [];
        states.push(yield* gate.check(threadId, null));
        yield* gate.register(threadId, "op-1");
        states.push(yield* gate.check(threadId, "op-1"));
        // A stale attempt cannot open a newer one.
        yield* gate.open(threadId, "op-0");
        states.push(yield* gate.check(threadId, "op-1"));
        yield* gate.open(threadId, "op-1");
        states.push(yield* gate.check(threadId, "op-1"));
        yield* gate.unregister(threadId, "op-1");
        states.push(yield* gate.check(threadId, "op-1"));
        states.push(yield* gate.check(threadId, null));
        return states;
      }),
    );
    expect(result).toEqual(["none", "gating", "gating", "none", "orphaned", "none"]);
  });
});
