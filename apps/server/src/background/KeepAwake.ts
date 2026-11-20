import { spawn } from "node:child_process";
import { Duration, Effect, Schedule, Stream } from "effect";
import type { OrchestrationEngineShape } from "../orchestration/Services/OrchestrationEngine";
import type { ServerSettingsShape } from "../serverSettings";
import { busyThreadIds } from "../orchestration/sessionBusy";

export function inhibitorCommand(platform: NodeJS.Platform, pid: number) {
  switch (platform) {
    case "darwin":
      return { command: "caffeinate", args: ["-i", "-w", String(pid)] };
    case "linux":
      return {
        command: "systemd-inhibit",
        args: [
          "--what=idle:sleep",
          "--who=F5",
          "--why=Agents are working",
          "--mode=block",
          "tail",
          "--pid=" + pid,
          "-f",
          "/dev/null",
        ],
      };
    case "win32":
      return {
        command: "powershell.exe",
        args: [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          "$t = Add-Type -Name Power -Namespace F5 -PassThru -MemberDefinition '[DllImport(\"kernel32.dll\")] public static extern uint SetThreadExecutionState(uint f);'; [void]$t::SetThreadExecutionState([uint32]2147483649); Wait-Process -Id " +
            pid,
        ],
      };
    default:
      return undefined;
  }
}

export function holdWhileWanted<E, R>(
  wanted: Stream.Stream<boolean, E, R>,
  hold: Effect.Effect<void>,
  grace: Duration.Input = "60 seconds",
) {
  return wanted.pipe(
    Stream.changes,
    Stream.switchMap((on) =>
      on ? Stream.succeed(true) : Stream.fromEffect(Effect.as(Effect.sleep(grace), false)),
    ),
    Stream.changes,
    Stream.switchMap((on) => (on ? Stream.fromEffect(hold) : Stream.empty)),
    Stream.runDrain,
  );
}

const backoff = Schedule.exponential("5 seconds").pipe(
  Schedule.modifyDelay((duration) => Effect.succeed(Duration.min(duration, Duration.minutes(10)))),
);

/** The watcher exits if this server dies; scope teardown kills its whole process group. */
export const startKeepAwake = (engine: OrchestrationEngineShape, settings: ServerSettingsShape) =>
  Effect.gen(function* () {
    const command = inhibitorCommand(process.platform, process.pid);
    if (!command) return;
    const hold = Effect.acquireRelease(
      Effect.tryPromise(
        () =>
          new Promise<ReturnType<typeof spawn>>((resolve, reject) => {
            const child = spawn(command.command, command.args, {
              stdio: "ignore",
              shell: false,
              detached: process.platform !== "win32",
            });
            child.once("error", reject);
            child.once("spawn", () => resolve(child));
          }),
      ),
      (child) =>
        Effect.sync(() => {
          if (!child.pid) return;
          try {
            if (process.platform === "win32") child.kill();
            else process.kill(-child.pid, "SIGTERM");
          } catch {
            /* The watcher may already have exited. */
          }
        }),
    ).pipe(
      Effect.flatMap((child) =>
        Effect.tryPromise(
          () =>
            new Promise<never>((_resolve, reject) => {
              child.once("error", reject);
              child.once("close", () => reject(new Error("Sleep inhibitor exited.")));
            }),
        ),
      ),
      Effect.scoped,
      Effect.tapError((error) => Effect.logWarning("Could not hold the server awake", { error })),
      Effect.retry(backoff),
      Effect.ignore,
    );
    const wanted = Stream.merge(
      Stream.fromEffect(Effect.void).pipe(Stream.repeat(Schedule.spaced("5 seconds"))),
      engine.streamDomainEvents.pipe(
        Stream.filter(
          (event) => event.type === "thread.session-set" || event.type === "thread.deleted",
        ),
        Stream.map(() => undefined),
      ),
    ).pipe(
      Stream.mapEffect(() =>
        Effect.gen(function* () {
          const enabled = (yield* settings.getSettings).keepAwakeWhileAgentsWork;
          return enabled && busyThreadIds(yield* engine.getReadModel()).size > 0;
        }).pipe(Effect.orElseSucceed(() => false)),
      ),
    );
    yield* holdWhileWanted(wanted, hold).pipe(Effect.forkScoped);
  });
