import {
  CommandId,
  EventId,
  MessageId,
  ProjectId,
  ThreadId,
  type OrchestrationEvent,
  type OrchestrationReadModel,
} from "@t3tools/contracts";
import { Effect, Exit } from "effect";
import { describe, expect, it } from "vitest";

import { decideOrchestrationCommand } from "./decider.ts";
import { createEmptyReadModel, projectEvent } from "./projector.ts";

const NOW = "2026-08-15T09:00:00.000Z";
const LATER = "2026-08-15T12:00:00.000Z";
const THREAD_1 = ThreadId.makeUnsafe("thread-pin-1");
const THREAD_2 = ThreadId.makeUnsafe("thread-pin-2");
type LegacyPinsImportedEvent = Omit<
  Extract<OrchestrationEvent, { type: "thread.legacy-pins-imported" }>,
  "sequence"
>;

async function addThread(readModel: OrchestrationReadModel, threadId: ThreadId, sequence: number) {
  return Effect.runPromise(
    projectEvent(readModel, {
      sequence,
      eventId: EventId.makeUnsafe(`event-create-${threadId}`),
      aggregateKind: "thread",
      aggregateId: threadId,
      type: "thread.created",
      occurredAt: NOW,
      commandId: CommandId.makeUnsafe(`command-create-${threadId}`),
      causationEventId: null,
      correlationId: CommandId.makeUnsafe(`command-create-${threadId}`),
      metadata: {},
      payload: {
        threadId,
        projectId: ProjectId.makeUnsafe("project-pins"),
        title: `Thread ${threadId}`,
        model: "gpt-5-codex",
        interactionMode: "default",
        runtimeMode: "full-access",
        branch: null,
        worktreePath: null,
        createdAt: NOW,
        updatedAt: NOW,
      },
    }),
  );
}

async function makeReadModel() {
  const first = await addThread(createEmptyReadModel(NOW), THREAD_1, 1);
  return addThread(first, THREAD_2, 2);
}

async function applyDecision(
  readModel: OrchestrationReadModel,
  decision:
    | Omit<OrchestrationEvent, "sequence">
    | ReadonlyArray<Omit<OrchestrationEvent, "sequence">>,
) {
  let next = readModel;
  const events = Array.isArray(decision) ? decision : [decision];
  for (const [index, event] of events.entries()) {
    next = await Effect.runPromise(
      projectEvent(next, { ...event, sequence: next.snapshotSequence + index + 1 }),
    );
  }
  return next;
}

describe("thread pins and snoozes", () => {
  it("replaces pins atomically and rejects a stale revision", async () => {
    const readModel = await makeReadModel();
    const decision = await Effect.runPromise(
      decideOrchestrationCommand({
        readModel,
        command: {
          type: "thread.pins.replace",
          commandId: CommandId.makeUnsafe("command-pin"),
          threadId: THREAD_1,
          pinnedThreadIds: [THREAD_2, THREAD_1],
          expectedRevision: 0,
          createdAt: NOW,
        },
      }),
    );
    const pinned = await applyDecision(readModel, decision);

    expect(pinned.pinRevision).toBe(1);
    expect(pinned.threads.find((thread) => thread.id === THREAD_2)?.pinOrderKey).toBe(0);
    expect(pinned.threads.find((thread) => thread.id === THREAD_1)?.pinOrderKey).toBe(1);

    const stale = await Effect.runPromiseExit(
      decideOrchestrationCommand({
        readModel: pinned,
        command: {
          type: "thread.pins.replace",
          commandId: CommandId.makeUnsafe("command-pin-stale"),
          threadId: THREAD_1,
          pinnedThreadIds: [THREAD_1],
          expectedRevision: 0,
          createdAt: NOW,
        },
      }),
    );
    expect(Exit.isFailure(stale)).toBe(true);
  });

  it("snoozing unpins and pinning wakes a thread", async () => {
    const readModel = await makeReadModel();
    const pinDecision = await Effect.runPromise(
      decideOrchestrationCommand({
        readModel,
        command: {
          type: "thread.pins.replace",
          commandId: CommandId.makeUnsafe("command-pin-before-snooze"),
          threadId: THREAD_1,
          pinnedThreadIds: [THREAD_1],
          expectedRevision: 0,
          createdAt: NOW,
        },
      }),
    );
    const pinned = await applyDecision(readModel, pinDecision);
    const snoozeDecision = await Effect.runPromise(
      decideOrchestrationCommand({
        readModel: pinned,
        command: {
          type: "thread.snooze",
          commandId: CommandId.makeUnsafe("command-snooze"),
          threadId: THREAD_1,
          until: LATER,
          createdAt: NOW,
        },
      }),
    );
    const snoozed = await applyDecision(pinned, snoozeDecision);

    expect(snoozed.pinRevision).toBe(2);
    expect(snoozed.threads.find((thread) => thread.id === THREAD_1)).toMatchObject({
      pinnedAt: null,
      pinOrderKey: null,
      snoozedUntil: LATER,
      snoozedAt: NOW,
    });

    const repinDecision = await Effect.runPromise(
      decideOrchestrationCommand({
        readModel: snoozed,
        command: {
          type: "thread.pins.replace",
          commandId: CommandId.makeUnsafe("command-repin"),
          threadId: THREAD_1,
          pinnedThreadIds: [THREAD_1],
          expectedRevision: 2,
          createdAt: LATER,
        },
      }),
    );
    const repinned = await applyDecision(snoozed, repinDecision);
    expect(repinned.threads.find((thread) => thread.id === THREAD_1)).toMatchObject({
      pinnedAt: LATER,
      pinOrderKey: 0,
      snoozedUntil: null,
      snoozedAt: null,
    });
  });

  it("imports legacy pins after server pins and reports invalid IDs idempotently", async () => {
    const readModel = await makeReadModel();
    const initialPin = await Effect.runPromise(
      decideOrchestrationCommand({
        readModel,
        command: {
          type: "thread.pins.replace",
          commandId: CommandId.makeUnsafe("command-pin-before-import"),
          threadId: THREAD_2,
          pinnedThreadIds: [THREAD_2],
          expectedRevision: 0,
          createdAt: NOW,
        },
      }),
    );
    const pinned = await applyDecision(readModel, initialPin);
    const importDecision = await Effect.runPromise(
      decideOrchestrationCommand({
        readModel: pinned,
        command: {
          type: "thread.pins.import-legacy",
          commandId: CommandId.makeUnsafe("command-import-legacy-pins"),
          threadId: THREAD_2,
          legacyThreadIds: [THREAD_1, ThreadId.makeUnsafe("thread-missing")],
          expectedRevision: 1,
          createdAt: LATER,
        },
      }),
    );
    expect(Array.isArray(importDecision)).toBe(false);
    const importEvent = (Array.isArray(importDecision) ? importDecision[0] : importDecision) as
      | LegacyPinsImportedEvent
      | undefined;
    if (importEvent?.type !== "thread.legacy-pins-imported") {
      throw new Error("Expected a legacy pin import event.");
    }
    expect(importEvent.payload).toMatchObject({
      pinnedThreadIds: [THREAD_2, THREAD_1],
      acceptedThreadIds: [THREAD_1],
      overflowedThreadIds: [],
      unknownThreadIds: ["thread-missing"],
      pinRevision: 2,
    });
    const imported = await applyDecision(pinned, importEvent);

    const repeated = await Effect.runPromise(
      decideOrchestrationCommand({
        readModel: imported,
        command: {
          type: "thread.pins.import-legacy",
          commandId: CommandId.makeUnsafe("command-import-legacy-pins-again"),
          threadId: THREAD_2,
          legacyThreadIds: [THREAD_1],
          expectedRevision: 2,
          createdAt: LATER,
        },
      }),
    );
    const repeatedEvent = (Array.isArray(repeated) ? repeated[0] : repeated) as
      | LegacyPinsImportedEvent
      | undefined;
    if (repeatedEvent?.type !== "thread.legacy-pins-imported") {
      throw new Error("Expected a repeated legacy pin import event.");
    }
    expect(repeatedEvent.payload.pinRevision).toBe(2);
  });

  it("wakes only for foreground work and immediate requests", async () => {
    const readModel = await makeReadModel();
    const snoozeDecision = await Effect.runPromise(
      decideOrchestrationCommand({
        readModel,
        command: {
          type: "thread.snooze",
          commandId: CommandId.makeUnsafe("command-snooze-for-wake"),
          threadId: THREAD_1,
          until: LATER,
          createdAt: NOW,
        },
      }),
    );
    const snoozed = await applyDecision(readModel, snoozeDecision);

    const toolProgress = await Effect.runPromise(
      decideOrchestrationCommand({
        readModel: snoozed,
        command: {
          type: "thread.activity.append",
          commandId: CommandId.makeUnsafe("command-tool-progress"),
          threadId: THREAD_1,
          activity: {
            id: EventId.makeUnsafe("activity-tool-progress"),
            tone: "tool",
            kind: "tool.updated",
            summary: "Still running",
            payload: {},
            turnId: null,
            createdAt: NOW,
          },
          createdAt: NOW,
        },
      }),
    );
    expect(Array.isArray(toolProgress)).toBe(false);

    const approval = await Effect.runPromise(
      decideOrchestrationCommand({
        readModel: snoozed,
        command: {
          type: "thread.activity.append",
          commandId: CommandId.makeUnsafe("command-approval"),
          threadId: THREAD_1,
          activity: {
            id: EventId.makeUnsafe("activity-approval"),
            tone: "approval",
            kind: "approval.requested",
            summary: "Approval needed",
            payload: {},
            turnId: null,
            createdAt: NOW,
          },
          createdAt: NOW,
        },
      }),
    );
    expect(Array.isArray(approval)).toBe(true);
    expect(Array.isArray(approval) ? approval.map((event) => event.type) : []).toEqual([
      "thread.unsnoozed",
      "thread.activity-appended",
    ]);

    const foregroundTurn = await Effect.runPromise(
      decideOrchestrationCommand({
        readModel: snoozed,
        command: {
          type: "thread.turn.start",
          commandId: CommandId.makeUnsafe("command-foreground-turn"),
          threadId: THREAD_1,
          message: {
            messageId: MessageId.makeUnsafe("message-foreground-turn"),
            role: "user",
            text: "Wake up",
            attachments: [],
          },
          runtimeMode: "full-access",
          interactionMode: "default",
          createdAt: NOW,
        },
      }),
    );
    expect(Array.isArray(foregroundTurn) ? foregroundTurn[0]?.type : null).toBe("thread.unsnoozed");
  });
});
