import { describe, expect, it } from "@effect/vitest";
import { vi } from "vitest";
import { EventEmitter } from "node:events";
import type { spawn } from "node:child_process";
import { Effect, Queue, Stream, Scope, Exit } from "effect";
import { DEFAULT_SERVER_SETTINGS, type OrchestrationReadModel } from "@t3tools/contracts";
import * as TestClock from "effect/testing/TestClock";
import { holdWhileWanted, inhibitorCommand, startKeepAwake, makeSleepInhibitor } from "./KeepAwake";

describe("server sleep inhibition", () => {
  it.effect("leaves desktop sleep control to its existing controller", () =>
    Effect.gen(function* () {
      const read = vi.fn();
      yield* startKeepAwake(
        { getReadModel: read, streamDomainEvents: Stream.never },
        { getSettings: Effect.sync(read), subscribeChanges: Effect.succeed(Stream.never) },
        { desktop: true },
      );
      expect(read).not.toHaveBeenCalled();
    }).pipe(Effect.scoped),
  );
  it.effect("owns the WSL stdin pipe for the inhibitor lifetime and closes it on teardown", () =>
    Effect.gen(function* () {
      const spawned = yield* Queue.unbounded<void>();
      const ended = vi.fn();
      const stopGroup = vi.fn(() => true as const);
      const child = Object.assign(new EventEmitter(), {
        pid: 999999,
        stdin: { end: ended },
        kill: vi.fn(),
      });
      const spawnProcess = vi.fn(
        (
          _command: string,
          optionsArgs: readonly string[],
          options: { stdio: readonly string[] },
        ) => {
          expect(options.stdio[0]).toBe("pipe");
          expect(optionsArgs.at(-1)).toContain("[Console]::In.ReadToEnd()");
          queueMicrotask(() => {
            child.emit("spawn");
            Effect.runSync(Queue.offer(spawned, undefined));
          });
          return child;
        },
      ) as unknown as typeof spawn;
      const scope = yield* Scope.make();
      yield* makeSleepInhibitor(
        inhibitorCommand("linux", 123, "microsoft")!,
        spawnProcess,
        stopGroup,
      ).pipe(Effect.forkIn(scope));
      yield* Queue.take(spawned);
      expect(ended).not.toHaveBeenCalled();
      yield* Scope.close(scope, Exit.void);
      expect(ended).toHaveBeenCalledOnce();
      if (process.platform === "win32") expect(child.kill).toHaveBeenCalledOnce();
      else expect(stopGroup).toHaveBeenCalledWith(-999999, "SIGTERM");
    }).pipe(Effect.scoped),
  );
  it("ties every supported watcher to the server lifetime", () => {
    expect(inhibitorCommand("darwin", 123)).toEqual({
      command: "caffeinate",
      args: ["-i", "-w", "123"],
      stdin: "ignore",
    });
    expect(inhibitorCommand("linux", 123)?.args).toContain("--pid=123");
    expect(inhibitorCommand("linux", 123)?.args).toContain("--what=sleep");
    expect(inhibitorCommand("linux", 123)?.args).not.toContain("--what=idle:sleep");
    const wsl = inhibitorCommand("linux", 123, "6.6.87.2-microsoft-standard-WSL2");
    expect(wsl?.command).toBe("powershell.exe");
    expect(wsl?.stdin).toBe("pipe");
    expect(wsl?.args.at(-1)).toContain("[Console]::In.ReadToEnd()");
    expect(wsl?.args.at(-1)).not.toContain("Wait-Process");
    expect(inhibitorCommand("win32", 123)?.args.at(-1)).toContain("Wait-Process -Id 123");
    expect(inhibitorCommand("freebsd", 123)).toBeUndefined();
  });
  it.effect("watches settings, polls work only when enabled, and releases on shutdown", () =>
    Effect.gen(function* () {
      let enabled = false;
      let busy = true;
      let reads = 0;
      let workReads = 0;
      const settingsChanges = yield* Queue.unbounded<typeof DEFAULT_SERVER_SETTINGS>();
      const transitions = yield* Queue.unbounded<string>();
      const hold = Effect.acquireRelease(Queue.offer(transitions, "held"), () =>
        Queue.offer(transitions, "released"),
      ).pipe(Effect.andThen(Effect.never), Effect.scoped);
      const scope = yield* Scope.make();
      yield* Scope.provide(
        startKeepAwake(
          {
            getReadModel: () =>
              Effect.sync(() => {
                workReads++;
                return {
                  threads: busy
                    ? [
                        {
                          id: "thread",
                          deletedAt: null,
                          session: { status: "running", activeTurnId: null },
                        },
                      ]
                    : [],
                } as unknown as OrchestrationReadModel;
              }),
            streamDomainEvents: Stream.never,
          },
          {
            subscribeChanges: Effect.succeed(Stream.fromQueue(settingsChanges)),
            getSettings: Effect.sync(() => {
              reads++;
              return { ...DEFAULT_SERVER_SETTINGS, keepAwakeWhileAgentsWork: enabled };
            }),
          },
          { hold, platform: "linux", kernelRelease: "microsoft-WSL2" },
        ),
        scope,
      );
      yield* TestClock.adjust("5 seconds");
      expect(yield* Queue.size(transitions)).toBe(0);
      expect(reads).toBe(1);
      expect(workReads).toBe(0);
      enabled = true;
      yield* Queue.offer(settingsChanges, {
        ...DEFAULT_SERVER_SETTINGS,
        keepAwakeWhileAgentsWork: true,
      });
      yield* TestClock.adjust("5 seconds");
      expect(reads).toBe(1);
      expect(workReads).toBeGreaterThan(0);
      expect(yield* Queue.take(transitions)).toBe("held");
      busy = false;
      yield* TestClock.adjust("70 seconds");
      expect(yield* Queue.take(transitions)).toBe("released");
      busy = true;
      yield* TestClock.adjust("5 seconds");
      expect(yield* Queue.take(transitions)).toBe("held");
      yield* Scope.close(scope, Exit.void);
      expect(yield* Queue.take(transitions)).toBe("released");
    }).pipe(Effect.scoped),
  );
  it.effect("reuses the hold across queued work and releases after the last grace period", () =>
    Effect.gen(function* () {
      const wanted = yield* Queue.unbounded<boolean>();
      const transitions = yield* Queue.unbounded<string>();
      const hold = Effect.acquireRelease(Queue.offer(transitions, "held"), () =>
        Queue.offer(transitions, "released"),
      ).pipe(Effect.andThen(Effect.never), Effect.scoped);
      yield* holdWhileWanted(Stream.fromQueue(wanted), hold).pipe(Effect.forkScoped);
      yield* Queue.offer(wanted, false);
      yield* TestClock.adjust("2 minutes");
      expect(yield* Queue.size(transitions)).toBe(0);
      yield* Queue.offer(wanted, true);
      expect(yield* Queue.take(transitions)).toBe("held");
      yield* Queue.offer(wanted, false);
      yield* TestClock.adjust("30 seconds");
      yield* Queue.offer(wanted, true);
      yield* TestClock.adjust("2 minutes");
      expect(yield* Queue.size(transitions)).toBe(0);
      yield* Queue.offer(wanted, false);
      yield* TestClock.adjust("2 minutes");
      expect(yield* Queue.take(transitions)).toBe("released");
    }).pipe(Effect.scoped),
  );
});
