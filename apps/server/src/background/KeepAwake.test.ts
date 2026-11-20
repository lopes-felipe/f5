import { describe, expect, it } from "@effect/vitest";
import { Effect, Queue, Stream } from "effect";
import * as TestClock from "effect/testing/TestClock";
import { holdWhileWanted, inhibitorCommand } from "./KeepAwake";

describe("server sleep inhibition", () => {
  it("ties every supported watcher to the server lifetime", () => {
    expect(inhibitorCommand("darwin", 123)).toEqual({
      command: "caffeinate",
      args: ["-i", "-w", "123"],
    });
    expect(inhibitorCommand("linux", 123)?.args).toContain("--pid=123");
    expect(inhibitorCommand("win32", 123)?.args.at(-1)).toContain("Wait-Process -Id 123");
    expect(inhibitorCommand("freebsd", 123)).toBeUndefined();
  });
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
