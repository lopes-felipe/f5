import { killProcessTree } from "@t3tools/shared/processTree";
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
 *
 * The spawner starts children detached, as process-group leaders on POSIX.
 * The group gets SIGKILL even when the leader exits within the grace period:
 * a wrapper that honours SIGTERM can leave a descendant that does not, and
 * the spawner only cleans up the group after a non-zero exit code.
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
      if (process.platform !== "win32") {
        // ESRCH once the whole group is gone; killProcessTree swallows it.
        yield* Effect.sync(() =>
          killProcessTree(
            { pid: Number(handle.pid), kill: () => false },
            { isGroupLeader: true, signal: "SIGKILL" },
          ),
        );
      } else if (yield* isRunning(handle)) {
        // Windows: the spawner's kill is already `taskkill /T /F`.
        yield* handle
          .kill({ killSignal: "SIGKILL" })
          .pipe(Effect.timeoutOption("1 second"), Effect.ignore);
      }
    }).pipe(Effect.uninterruptible),
  );
