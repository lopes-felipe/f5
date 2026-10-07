import {
  CommandId,
  EventId,
  OrchestrationSession,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import { Effect, Schema } from "effect";
import { describe, expect, it } from "vitest";
import { decideOrchestrationCommand } from "./decider.ts";
import { createEmptyReadModel, projectEvent } from "./projector.ts";

const at = "2026-10-07T12:00:00.000Z";
const threadId = ThreadId.makeUnsafe("limited-thread");
const limit = {
  windows: [{ id: "five_hour", label: "5-hour", resetsAt: "2026-10-07T13:00:00.000Z" }],
  resetsAt: "2026-10-07T13:00:00.000Z",
  resetSource: "provider" as const,
  evidence: "typed" as const,
  providerInstanceId: ProviderInstanceId.makeUnsafe("claude"),
  turnId: TurnId.makeUnsafe("limited-turn"),
  deliveryId: null,
};
const session = Schema.decodeUnknownSync(OrchestrationSession)({
  threadId,
  status: "error",
  providerName: "claudeAgent",
  runtimeMode: "full-access",
  activeTurnId: null,
  lastError: "Limit reached",
  lastErrorId: "failure-1",
  usageLimit: limit,
  updatedAt: at,
});
async function model() {
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
        title: "Limited",
        model: "claude-sonnet",
        interactionMode: "default",
        runtimeMode: "full-access",
        branch: null,
        worktreePath: null,
        createdAt: at,
        updatedAt: at,
      },
    }),
  );
  return { ...created, threads: created.threads.map((thread) => ({ ...thread, session })) };
}
async function decide(next: typeof session) {
  const result = await Effect.runPromise(
    decideOrchestrationCommand({
      readModel: await model(),
      command: {
        type: "thread.session.set",
        commandId: CommandId.makeUnsafe("session-write"),
        threadId,
        session: next,
        createdAt: at,
      },
    }),
  );
  const event = Array.isArray(result) ? result[0] : result;
  if (event?.type !== "thread.session-set") throw new Error("Expected session event");
  return event.payload.session;
}
describe("usage limit carry-over", () => {
  it("keeps a limit through an exit or token write with the same error identity", async () => {
    const { usageLimit: _, ...previous } = session;
    expect((await decide({ ...previous, status: "stopped" })).usageLimit).toEqual(limit);
  });
  it("clears a limit for a different error or successful turn", async () => {
    const { usageLimit: _, ...previous } = session;
    expect((await decide({ ...previous, lastErrorId: "failure-2" })).usageLimit).toBeNull();
    expect(
      (await decide({ ...previous, lastErrorId: null, lastError: null, status: "ready" }))
        .usageLimit,
    ).toBeNull();
  });
  it("honors an explicit clear", async () => {
    expect((await decide({ ...session, usageLimit: null })).usageLimit).toBeNull();
  });
});
