import { Deferred, Effect, Fiber, Option, Scope } from "effect";
import { expect, test } from "vitest";
import { tryWithProviderThreadAccess, withProviderThreadAccess } from "./providerThreadAccess.ts";

test("interactive access fails immediately during a launch, preserves exclusion, and remains reentrant", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const entered = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        let ran = false;
        const launch = yield* withProviderThreadAccess(
          "busy-launch",
          Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release))),
        ).pipe(Effect.forkIn(yield* Scope.Scope));
        yield* Deferred.await(entered);
        const result = yield* tryWithProviderThreadAccess(
          "busy-launch",
          Effect.sync(() => {
            ran = true;
          }),
        );
        expect(Option.isNone(result)).toBe(true);
        expect(ran).toBe(false);
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(launch);
        expect(
          yield* tryWithProviderThreadAccess("busy-launch", Effect.succeed("terminal")),
        ).toEqual(Option.some("terminal"));
        expect(
          yield* withProviderThreadAccess(
            "busy-launch",
            tryWithProviderThreadAccess("busy-launch", Effect.succeed("nested")),
          ),
        ).toEqual(Option.some("nested"));
      }),
    ),
  );
});
