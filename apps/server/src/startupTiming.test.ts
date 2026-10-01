import { Deferred, Effect, Fiber } from "effect";
import { describe, expect, it } from "vitest";

import {
  formatStillStartingMessage,
  getCurrentStartupPhase,
  withStartupPhaseTiming,
} from "./startupTiming.ts";

describe("startup phase tracking", () => {
  it("reports the innermost running phase and clears it when phases end", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        expect(getCurrentStartupPhase()).toBeNull();
        const release = yield* Deferred.make<void>();
        const entered = yield* Deferred.make<void>();
        const fiber = yield* withStartupPhaseTiming(
          "outer",
          withStartupPhaseTiming(
            "inner",
            Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release))),
          ),
        ).pipe(Effect.forkChild);
        yield* Deferred.await(entered);
        expect(getCurrentStartupPhase()?.phase).toBe("inner");
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(fiber);
        expect(getCurrentStartupPhase()).toBeNull();
      }),
    );
  });

  it("clears a phase that fails", async () => {
    const exit = await Effect.runPromiseExit(
      withStartupPhaseTiming("failing", Effect.fail("boom")),
    );
    expect(exit._tag).toBe("Failure");
    expect(getCurrentStartupPhase()).toBeNull();
  });
});

describe("formatStillStartingMessage", () => {
  it("names the running phase and the elapsed time", () => {
    expect(
      formatStillStartingMessage({
        phase: "orchestration.projection.bootstrap",
        elapsedMs: 45_400,
      }),
    ).toBe(
      "Server is still starting (orchestration.projection.bootstrap, 45s elapsed). Try again shortly.",
    );
  });

  it("omits the phase when none is running", () => {
    expect(formatStillStartingMessage({ phase: null, elapsedMs: 55_000 })).toBe(
      "Server is still starting (55s elapsed). Try again shortly.",
    );
  });
});
