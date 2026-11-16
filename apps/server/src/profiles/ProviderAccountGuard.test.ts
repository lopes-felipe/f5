import { describe, expect, it } from "vitest";
import { Deferred, Effect, Fiber } from "effect";
import {
  beginAccountChange,
  beginProviderUpdate,
  withAccountAdmission,
} from "./ProviderAccountGuard.ts";

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

it("blocks shared installations, isolates profile servers, and releases admissions after failure", async () => {
  const release = beginProviderUpdate("updates", "physical", ["first", "second"]);
  try {
    for (const id of ["first", "second"])
      expect(
        (
          await Effect.runPromise(
            Effect.void.pipe(withAccountAdmission("updates", id, "start"), Effect.flip),
          )
        ).message,
      ).toContain("update in progress");
    expect(
      (
        await Effect.runPromise(
          Effect.void.pipe(
            withAccountAdmission("updates", "new-alias", "send", "physical"),
            Effect.flip,
          ),
        )
      ).message,
    ).toContain("update in progress");
    await Effect.runPromise(
      Effect.void.pipe(withAccountAdmission("updates", "different", "send", "other-install")),
    );
    await Effect.runPromise(
      Effect.void.pipe(withAccountAdmission("other-server", "first", "send", "physical")),
    );
    expect(() => beginAccountChange("updates", "first")).toThrow("update in progress");
  } finally {
    release();
  }
  await Effect.runPromise(Effect.void.pipe(withAccountAdmission("updates", "first", "send")));
});

it("refuses an update during a dispatch admission and leaves every shared instance available", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const sending = yield* Deferred.succeed(started, undefined).pipe(
        Effect.andThen(Effect.never),
        withAccountAdmission("update-race", "second", "send"),
        Effect.forkChild,
      );
      yield* Deferred.await(started);
      expect(() => beginProviderUpdate("update-race", "physical", ["first", "second"])).toThrow(
        "starting work",
      );
      yield* Effect.void.pipe(withAccountAdmission("update-race", "first", "start"));
      yield* Fiber.interrupt(sending);
      beginProviderUpdate("update-race", "physical", ["first", "second"])();
    }),
  );
});
