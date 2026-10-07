import {
  CommandId,
  EventId,
  OrchestrationSession,
  MessageId,
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
  it("clears a carried limit when another turn becomes active", async () => {
    const { usageLimit: _, ...previous } = session;
    expect(
      (
        await decide({
          ...previous,
          activeTurnId: TurnId.makeUnsafe("new-turn"),
          status: "running",
        })
      ).usageLimit,
    ).toBeNull();
    expect(
      (await decide({ ...previous, activeTurnId: limit.turnId, status: "running" })).usageLimit,
    ).toEqual(limit);
  });
  it("honors an explicit clear", async () => {
    expect((await decide({ ...session, usageLimit: null })).usageLimit).toBeNull();
  });
});

describe("queued recovery settings", () => {
  it("uses current permissions, interaction and model instead of restoring the scheduled snapshot", async () => {
    const readModel = await model();
    readModel.threads = readModel.threads.map((thread) => ({
      ...thread,
      runtimeMode: "approval-required",
      interactionMode: "plan",
      model: "current-model",
      session: { ...session, workflowExecutionProfile: "attended-readonly" },
      modelSelection: {
        instanceId: ProviderInstanceId.makeUnsafe("current-instance"),
        model: "current-model",
      },
    }));
    const result = await Effect.runPromise(
      decideOrchestrationCommand({
        readModel,
        command: {
          type: "thread.turn.start",
          commandId: CommandId.makeUnsafe("resume"),
          threadId,
          dispatchSource: "next-turn-queue",
          presentation: "continuation",
          runtimeMode: "full-access",
          interactionMode: "default",
          model: "old-model",
          modelSelection: {
            instanceId: ProviderInstanceId.makeUnsafe("old-instance"),
            model: "old-model",
          },
          message: {
            messageId: MessageId.makeUnsafe("resume-message"),
            role: "user",
            text: "continue",
            attachments: [],
          },
          createdAt: at,
        },
      }),
    );
    const events = Array.isArray(result) ? result : [result];
    expect(events.map((event) => event.type)).toEqual([
      "thread.message-sent",
      "thread.turn-start-requested",
    ]);
    const start = events.find((event) => event.type === "thread.turn-start-requested");
    expect(start?.payload).toMatchObject({
      runtimeMode: "approval-required",
      interactionMode: "plan",
      workflowExecutionProfile: "attended-readonly",
      model: "current-model",
      modelSelection: { instanceId: "current-instance", model: "current-model" },
    });
  });
});
