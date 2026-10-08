import {
  ProviderInstanceId,
  ThreadId,
  type OrchestrationEvent,
  type OrchestrationReadModel,
} from "@t3tools/contracts";
import { Effect, Layer, ManagedRuntime, Option, Scope, Stream } from "effect";
import { describe, expect, it } from "vitest";

import type { ProviderInstance } from "../../provider/ProviderDriver.ts";
import { ProviderInstanceRegistry } from "../../provider/Services/ProviderInstanceRegistry.ts";
import {
  ProviderSessionDirectory,
  type ProviderRuntimeBindingWithMetadata,
} from "../../provider/Services/ProviderSessionDirectory.ts";
import { NativeSessionCleanupReactor } from "../Services/NativeSessionCleanupReactor.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import {
  claudeSessionIdOfBinding,
  NativeSessionCleanupReactorLive,
} from "./NativeSessionCleanupReactor.ts";

const SESSION = "0f8f2a52-5b0f-4c7e-9d7a-1a2b3c4d5e6f";
const OTHER_SESSION = "1f8f2a52-5b0f-4c7e-9d7a-1a2b3c4d5e6f";
const INSTANCE = ProviderInstanceId.makeUnsafe("claude-work");

function binding(
  threadId: string,
  sessionId: string,
  provider: "claudeAgent" | "codex" = "claudeAgent",
): ProviderRuntimeBindingWithMetadata {
  return {
    threadId: ThreadId.makeUnsafe(threadId),
    provider,
    providerInstanceId: INSTANCE,
    resumeCursor: { resume: sessionId },
    lastSeenAt: "2026-10-08T00:00:00.000Z",
  };
}

function deletedEvent(threadId: string): OrchestrationEvent {
  return {
    type: "thread.deleted",
    payload: { threadId: ThreadId.makeUnsafe(threadId), deletedAt: "2026-10-08T00:00:00.000Z" },
  } as unknown as OrchestrationEvent;
}

/** Adapter stop and delete calls, in order, from the latest runCleanup. */
let lastEvents: string[] = [];

async function runCleanup(input: {
  readonly bindings: ReadonlyArray<ProviderRuntimeBindingWithMetadata>;
  readonly deletedThreadIds: ReadonlyArray<string>;
  readonly liveThreadIds: ReadonlyArray<string>;
  readonly events: ReadonlyArray<OrchestrationEvent>;
  readonly failDelete?: boolean;
  /** Live adapter session: "stops" ends on stopSession, "stuck" survives it. */
  readonly liveSession?: "stops" | "stuck";
  /** The instance shares its store with the user's CLI (no deleteNativeSession). */
  readonly sharedStore?: boolean;
}) {
  const deletions: Array<{ instanceId: string; sessionId: string }> = [];
  const events: string[] = [];
  let live = input.liveSession !== undefined;
  const readModel = {
    threads: [
      ...input.deletedThreadIds.map((id) => ({ id, deletedAt: "2026-10-08T00:00:00.000Z" })),
      ...input.liveThreadIds.map((id) => ({ id, deletedAt: null })),
    ],
  } as unknown as OrchestrationReadModel;
  const instance = {
    instanceId: INSTANCE,
    adapter: {
      hasSession: () => Effect.sync(() => live),
      stopSession: () =>
        Effect.sync(() => {
          events.push("stop");
          if (input.liveSession === "stops") live = false;
        }),
    },
    ...(input.sharedStore
      ? {}
      : {
          deleteNativeSession: (sessionId: string) =>
            input.failDelete
              ? Effect.die(new Error("disk on fire"))
              : Effect.sync(() => {
                  events.push("delete");
                  deletions.push({ instanceId: INSTANCE, sessionId });
                  return { removed: [`/profiles/work/.claude/projects/-repo/${sessionId}.jsonl`] };
                }),
        }),
  } as unknown as ProviderInstance;

  const runtime = ManagedRuntime.make(
    NativeSessionCleanupReactorLive.pipe(
      Layer.provideMerge(
        Layer.succeed(OrchestrationEngineService, {
          getReadModel: () => Effect.succeed(readModel),
          streamDomainEvents: Stream.fromIterable(input.events),
        } as never),
      ),
      Layer.provideMerge(
        Layer.succeed(ProviderSessionDirectory, {
          getBinding: (threadId: ThreadId) =>
            Effect.succeed(
              Option.fromNullishOr(input.bindings.find((entry) => entry.threadId === threadId)),
            ),
          listBindings: () => Effect.succeed(input.bindings),
        } as never),
      ),
      Layer.provideMerge(
        Layer.succeed(ProviderInstanceRegistry, {
          getInstance: (id: ProviderInstanceId) =>
            Effect.succeed(id === INSTANCE ? instance : undefined),
        } as never),
      ),
    ),
  );
  try {
    const reactor = await runtime.runPromise(Effect.service(NativeSessionCleanupReactor));
    const scope = await Effect.runPromise(Scope.make("sequential"));
    await runtime.runPromise(reactor.start.pipe(Scope.provide(scope)));
    for (let index = 0; index < 20; index += 1) await runtime.runPromise(Effect.yieldNow);
    await runtime.runPromise(reactor.drain);
    await Effect.runPromise(Scope.close(scope, { _tag: "Success", value: undefined } as never));
  } finally {
    await runtime.dispose();
  }
  lastEvents = events;
  return deletions;
}

describe("claudeSessionIdOfBinding", () => {
  it("reads only Claude UUID resume ids", () => {
    expect(claudeSessionIdOfBinding(binding("t", SESSION))).toBe(SESSION);
    expect(claudeSessionIdOfBinding(binding("t", SESSION, "codex"))).toBeUndefined();
    expect(claudeSessionIdOfBinding(binding("t", "not-a-uuid"))).toBeUndefined();
  });
});

describe("NativeSessionCleanupReactor", () => {
  it("deletes the deleted thread's transcript through its own instance", async () => {
    const deletions = await runCleanup({
      bindings: [binding("deleted", SESSION), binding("other", OTHER_SESSION)],
      deletedThreadIds: ["deleted"],
      liveThreadIds: ["other"],
      events: [deletedEvent("deleted")],
    });
    expect(deletions).toEqual([{ instanceId: INSTANCE, sessionId: SESSION }]);
  });

  it("skips a session another live thread (a fork) still references", async () => {
    const deletions = await runCleanup({
      bindings: [binding("deleted", SESSION), binding("fork", SESSION)],
      deletedThreadIds: ["deleted"],
      liveThreadIds: ["fork"],
      events: [deletedEvent("deleted")],
    });
    expect(deletions).toEqual([]);
  });

  it("deletes when the only other reference is itself deleted", async () => {
    const deletions = await runCleanup({
      bindings: [binding("deleted", SESSION), binding("fork", SESSION)],
      deletedThreadIds: ["deleted", "fork"],
      liveThreadIds: [],
      events: [deletedEvent("deleted")],
    });
    expect(deletions).toEqual([{ instanceId: INSTANCE, sessionId: SESSION }]);
  });

  it("ignores non-Claude bindings and swallows deletion failures", async () => {
    expect(
      await runCleanup({
        bindings: [binding("codex", SESSION, "codex")],
        deletedThreadIds: ["codex"],
        liveThreadIds: [],
        events: [deletedEvent("codex")],
      }),
    ).toEqual([]);
    await expect(
      runCleanup({
        bindings: [binding("deleted", SESSION)],
        deletedThreadIds: ["deleted"],
        liveThreadIds: [],
        events: [deletedEvent("deleted")],
        failDelete: true,
      }),
    ).resolves.toEqual([]);
  });

  it("stops a still-running session before deleting its transcript", async () => {
    await runCleanup({
      bindings: [binding("deleted", SESSION)],
      deletedThreadIds: ["deleted"],
      liveThreadIds: [],
      events: [deletedEvent("deleted")],
      liveSession: "stops",
    });
    expect(lastEvents).toEqual(["stop", "delete"]);
  });

  it("keeps the transcript when the session cannot be stopped", async () => {
    const result = await runCleanup({
      bindings: [binding("deleted", SESSION)],
      deletedThreadIds: ["deleted"],
      liveThreadIds: [],
      events: [deletedEvent("deleted")],
      liveSession: "stuck",
    });
    expect(lastEvents).toEqual(["stop"]);
    expect(result).toEqual([]);
  });

  it("never deletes from an instance whose store is shared with the user's CLI", async () => {
    expect(
      await runCleanup({
        bindings: [binding("deleted", SESSION)],
        deletedThreadIds: ["deleted"],
        liveThreadIds: [],
        events: [deletedEvent("deleted")],
        sharedStore: true,
      }),
    ).toEqual([]);
  });
});
