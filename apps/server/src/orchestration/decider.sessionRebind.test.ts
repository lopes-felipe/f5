import {
  CommandId,
  EventId,
  type OrchestrationLatestTurn,
  type OrchestrationSession,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { decideOrchestrationCommand } from "./decider.ts";
import { createEmptyReadModel, projectEvent } from "./projector.ts";

const at = "2026-11-23T21:12:12.000Z";
const projectedAt = "2026-11-23T21:13:11.000Z";
const adapterAt = "2026-11-23T21:12:12.775Z";
const threadId = ThreadId.makeUnsafe("rebind-thread");
const turnId = TurnId.makeUnsafe("turn-1");
const codex = ProviderInstanceId.makeUnsafe("codex");

const runningSession: OrchestrationSession = {
  threadId,
  status: "running",
  providerName: "codex",
  providerInstanceId: codex,
  runtimeMode: "full-access",
  activeTurnId: turnId,
  lastError: null,
  updatedAt: projectedAt,
};
const runningTurn: OrchestrationLatestTurn = {
  turnId,
  state: "running",
  requestedAt: at,
  startedAt: at,
  completedAt: null,
  assistantMessageId: null,
};
/** What a re-bind writes: the adapter's running record, without a turn. */
const rebound: OrchestrationSession = {
  ...runningSession,
  activeTurnId: null,
  updatedAt: adapterAt,
};

async function model(session: OrchestrationSession, latestTurn: OrchestrationLatestTurn | null) {
  const created = await Effect.runPromise(
    projectEvent(createEmptyReadModel(at), {
      sequence: 1,
      eventId: EventId.makeUnsafe("created"),
      aggregateKind: "thread",
      aggregateId: threadId,
      type: "thread.created",
      occurredAt: at,
      commandId: null,
      causationEventId: null,
      correlationId: null,
      metadata: {},
      payload: {
        threadId,
        projectId: ProjectId.makeUnsafe("project"),
        title: "Rebind",
        model: "gpt-6.1-sol",
        interactionMode: "default",
        runtimeMode: "full-access",
        branch: null,
        worktreePath: null,
        createdAt: at,
        updatedAt: at,
      },
    }),
  );
  return {
    ...created,
    threads: created.threads.map((thread) => ({ ...thread, session, latestTurn })),
  };
}

async function decide(input: {
  readonly current?: OrchestrationSession;
  readonly latestTurn?: OrchestrationLatestTurn | null;
  readonly next?: OrchestrationSession;
  readonly rebindLiveSession?: boolean;
}) {
  const result = await Effect.runPromise(
    decideOrchestrationCommand({
      readModel: await model(
        input.current ?? runningSession,
        input.latestTurn === undefined ? runningTurn : input.latestTurn,
      ),
      command: {
        type: "thread.session.set",
        commandId: CommandId.makeUnsafe("server:provider-session-set:test"),
        threadId,
        session: input.next ?? rebound,
        ...(input.rebindLiveSession === false ? {} : { rebindLiveSession: true }),
        createdAt: adapterAt,
      },
    }),
  );
  const event = Array.isArray(result) ? result[0] : result;
  if (event?.type !== "thread.session-set") throw new Error("Expected a session event");
  return event.payload.session;
}

describe("re-binding a live session", () => {
  it("keeps the running turn and never moves updatedAt backwards", async () => {
    const session = await decide({});
    expect(session.activeTurnId).toBe(turnId);
    expect(session.updatedAt).toBe(projectedAt);
  });

  it("keeps the newer adapter timestamp", async () => {
    const later = "2026-11-23T21:20:00.000Z";
    expect((await decide({ next: { ...rebound, updatedAt: later } })).updatedAt).toBe(later);
  });

  it("does not bring back a turn that settled while the refresh ran", async () => {
    // turn.completed was applied before the late re-bind reached the decider.
    const session = await decide({
      current: { ...runningSession, status: "ready", activeTurnId: null },
      latestTurn: { ...runningTurn, state: "completed", completedAt: projectedAt },
    });
    expect(session.activeTurnId).toBeNull();
    expect(session.updatedAt).toBe(adapterAt);
  });

  it("does not revive a leftover turn id on a session that is not running", async () => {
    for (const status of ["error", "interrupted", "ready", "starting"] as const) {
      const session = await decide({ current: { ...runningSession, status } });
      expect(session.activeTurnId).toBeNull();
    }
  });

  it("requires the latest turn to be that turn and still running", async () => {
    expect((await decide({ latestTurn: null })).activeTurnId).toBeNull();
    expect(
      (await decide({ latestTurn: { ...runningTurn, turnId: TurnId.makeUnsafe("turn-0") } }))
        .activeTurnId,
    ).toBeNull();
    expect(
      (await decide({ latestTurn: { ...runningTurn, state: "interrupted" } })).activeTurnId,
    ).toBeNull();
  });

  it("never carries a turn into another provider, instance or a non-running bind", async () => {
    for (const next of [
      { ...rebound, providerName: "claudeAgent" },
      { ...rebound, providerInstanceId: ProviderInstanceId.makeUnsafe("codex-work") },
      { ...rebound, status: "ready" as const },
    ]) {
      expect((await decide({ next })).activeTurnId).toBeNull();
    }
  });

  it("leaves session writes without the flag unchanged", async () => {
    const session = await decide({ rebindLiveSession: false });
    expect(session.activeTurnId).toBeNull();
    expect(session.updatedAt).toBe(adapterAt);
  });
});
