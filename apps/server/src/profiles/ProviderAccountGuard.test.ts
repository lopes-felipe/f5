import { describe, expect, it } from "vitest";
import { Deferred, Effect, Fiber } from "effect";
import { beginAccountChange, withAccountAdmission } from "./ProviderAccountGuard.ts";

describe("account change admission", () => {
  it("blocks starts and sends until account setup exits, without blocking another instance", async () => {
    const release = beginAccountChange("profile", "account");
    try {
      for (const operation of ["startSession", "sendTurn"]) {
        const failure = await Effect.runPromise(
          Effect.flip(Effect.void.pipe(withAccountAdmission("profile", "account", operation))),
        );
        expect(failure.message).toContain("Account change in progress");
      }
      await Effect.runPromise(
        Effect.void.pipe(withAccountAdmission("profile", "other", "sendTurn")),
      );
    } finally {
      release();
    }
    await Effect.runPromise(
      Effect.void.pipe(withAccountAdmission("profile", "account", "sendTurn")),
    );
  });
  it("refuses a change while dispatch is awaiting acceptance and releases admission on interruption", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>();
        const fiber = yield* Deferred.succeed(started, undefined).pipe(
          Effect.andThen(Effect.never),
          withAccountAdmission("race", "account", "sendTurn"),
          Effect.forkChild,
        );
        yield* Deferred.await(started);
        expect(() => beginAccountChange("race", "account")).toThrow("starting work");
        yield* Fiber.interrupt(fiber);
        beginAccountChange("race", "account")();
      }),
    );
  });
});
