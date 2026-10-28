import { type Duration, Effect } from "effect";
import { type ChildProcessSpawner } from "effect/unstable/process";

const isRunning = (handle: ChildProcessSpawner.ChildProcessHandle) =>
  handle.isRunning.pipe(Effect.orElseSucceed(() => false));

/**
 * Stop a spawned helper when its scope closes: SIGTERM, then SIGKILL after
 * `grace`. Effect's own `forceKillAfter` only bounds sending SIGTERM, not the
 * wait for exit, so a helper that ignores SIGTERM would hold a timed-out or
 * interrupted request, and server shutdown, open. Register it right after
 * spawn so it runs before the spawner's own finalizer.
 */
export const terminateOnRelease = (
  handle: ChildProcessSpawner.ChildProcessHandle,
  grace: Duration.Input = "1 second",
) =>
  Effect.addFinalizer(() =>
    Effect.gen(function* () {
      if (!(yield* isRunning(handle))) return;
      yield* handle
        .kill({ killSignal: "SIGTERM" })
        .pipe(Effect.timeoutOption(grace), Effect.ignore);
      if (yield* isRunning(handle))
        yield* handle
          .kill({ killSignal: "SIGKILL" })
          .pipe(Effect.timeoutOption("1 second"), Effect.ignore);
    }).pipe(Effect.uninterruptible),
  );
