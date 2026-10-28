import { existsSync, readFileSync } from "node:fs";
import { Effect } from "effect";
import { TestClock } from "effect/testing";

/** CLI fixture source that ignores SIGTERM and never exits, reporting its PID. */
export const stalledCliSource = (pidPath: string) => `
process.on("SIGTERM", () => {});
require("node:fs").writeFileSync(${JSON.stringify(pidPath)}, String(process.pid));
setInterval(() => {}, 1_000);
`;

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

/** Poll in real time for up to 5 s, running `tick` (e.g. a TestClock advance) between polls. */
const poll = <A>(label: string, read: () => A | undefined, tick: Effect.Effect<void>) =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const value = read();
      if (value !== undefined) return value;
      yield* tick;
      yield* Effect.sleep("25 millis").pipe(TestClock.withLive);
    }
    return yield* Effect.die(new Error(`Timed out waiting for ${label}`));
  });

/** Wait for the fixture to start; the scope SIGKILLs it if the test leaves it running. */
export const awaitStalledCli = (pidPath: string) =>
  poll(
    "the stalled CLI to start",
    () => {
      const pid = existsSync(pidPath) ? Number(readFileSync(pidPath, "utf8")) : 0;
      return Number.isSafeInteger(pid) && pid > 0 ? pid : undefined;
    },
    Effect.void,
  ).pipe(
    Effect.tap((pid) =>
      Effect.addFinalizer(() =>
        Effect.sync(() => {
          if (isRunning(pid)) process.kill(pid, "SIGKILL");
        }),
      ),
    ),
  );

export const awaitProcessExit = (pid: number, tick: Effect.Effect<void> = Effect.void) =>
  poll(`process ${pid} to exit`, () => (isRunning(pid) ? undefined : true), tick);
