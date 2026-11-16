import {
  CommandId,
  EventId,
  MessageId,
  OrchestrationCommand,
  ProjectId,
  ThreadId,
  type OrchestrationReadModel,
} from "@t3tools/contracts";
import { Effect, Schema } from "effect";
import * as FastCheck from "effect/testing/FastCheck";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { decideOrchestrationCommand } from "./decider.ts";
import { hydrateDeciderReadModel, withoutDeletedThreadDetails } from "./deciderReadModel.ts";
import { createEmptyReadModel, projectEvent } from "./projector.ts";

const NOW = "2026-04-20T12:00:00.000Z";
const threadId = ThreadId.makeUnsafe("deleted-thread");
const messageId = MessageId.makeUnsafe("retained-message");
const projectId = ProjectId.makeUnsafe("project");
const commandId = CommandId.makeUnsafe("command");
async function fixture(): Promise<OrchestrationReadModel> {
  const model = await Effect.runPromise(
    projectEvent(createEmptyReadModel(NOW), {
      sequence: 1,
      eventId: EventId.makeUnsafe("created"),
      commandId,
      correlationId: commandId,
      causationEventId: null,
      aggregateKind: "thread",
      aggregateId: threadId,
      occurredAt: NOW,
      metadata: {},
      type: "thread.created",
      payload: {
        threadId,
        projectId,
        title: "Deleted history",
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
  return {
    ...model,
    threads: model.threads.map((thread) => ({
      ...thread,
      deletedAt: NOW,
      messages: [
        {
          id: messageId,
          role: "assistant",
          text: "retained prefix",
          reasoningText: "reasoning",
          turnId: null,
          streaming: false,
          createdAt: NOW,
          updatedAt: NOW,
        },
      ],
      proposedPlans: [
        {
          id: "plan",
          threadId,
          turnId: null,
          planMarkdown: "# Retained plan",
          implementedAt: null,
          implementationThreadId: null,
          createdAt: NOW,
          updatedAt: NOW,
        },
      ],
    })),
  };
}
function* members(schema: Schema.Top): Generator<Schema.Top> {
  if ("members" in schema && Array.isArray(schema.members)) {
    for (const child of schema.members) yield* members(child);
  } else yield schema;
}
async function outcome(model: OrchestrationReadModel, command: OrchestrationCommand) {
  return Effect.runPromise(
    decideOrchestrationCommand({ readModel: model, command }).pipe(
      Effect.match({
        onSuccess: (events) => ({ events }),
        onFailure: (error) => ({ error: { tag: error._tag, message: error.message } }),
      }),
    ),
  );
}

beforeEach(() => {
  vi.spyOn(crypto, "randomUUID").mockReturnValue("00000000-0000-4000-8000-000000000000");
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(NOW));
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});
describe("deleted thread decision parity", () => {
  it("preserves every thread-command schema's decisions without retaining deleted detail arrays", async () => {
    const original = await fixture();
    const filtered = withoutDeletedThreadDetails(original);
    expect(filtered.threads[0]?.messages).toEqual([]);
    const tested = new Set<string>();
    for (const member of members(OrchestrationCommand)) {
      if (!("fields" in member)) throw new Error("Expected a command struct");
      const fields = member.fields as Record<string, Schema.Top>;
      const type = FastCheck.sample(Schema.toArbitrary(fields.type!), { seed: 42, numRuns: 1 })[0];
      if (typeof type !== "string" || !type.startsWith("thread.")) continue;
      const generated = FastCheck.sample(Schema.toArbitrary(member), {
        seed: 42,
        numRuns: 1,
      })[0] as OrchestrationCommand;
      if (!generated.type.startsWith("thread.")) continue;
      const command = { ...generated, threadId, commandId, createdAt: NOW } as OrchestrationCommand;
      const hydrated = await Effect.runPromise(
        hydrateDeciderReadModel(filtered, command, (id) => {
          expect(id).toBe(threadId);
          return Effect.succeed(original.threads[0]!);
        }),
      );
      expect(await outcome(hydrated, command), command.type).toEqual(
        await outcome(original, command),
      );
      tested.add(command.type);
    }
    expect(tested.size).toBeGreaterThan(30);
    // A real retained completed message must suppress a duplicate delta.
    const delta: OrchestrationCommand = {
      type: "thread.message.assistant.delta",
      commandId,
      threadId,
      messageId,
      delta: " late",
      createdAt: NOW,
    };
    expect(await outcome(filtered, delta)).not.toEqual(await outcome(original, delta));
    const hydrated = await Effect.runPromise(
      hydrateDeciderReadModel(filtered, delta, () => Effect.succeed(original.threads[0]!)),
    );
    expect(await outcome(hydrated, delta)).toEqual({ events: [] });
    expect(filtered.threads[0]?.messages).toEqual([]);
  });
  it("loads deleted source-plan details for an active target without loading unrelated history", async () => {
    const original = await fixture();
    const targetId = ThreadId.makeUnsafe("active-target");
    const model = {
      ...original,
      threads: [
        ...original.threads,
        { ...original.threads[0]!, id: targetId, deletedAt: null, messages: [], proposedPlans: [] },
      ],
    };
    const read = vi.fn(() => Effect.succeed(original.threads[0]!));
    const command: OrchestrationCommand = {
      type: "thread.turn.start",
      commandId,
      threadId: targetId,
      message: { messageId, role: "user", text: "Implement", attachments: [] },
      sourceProposedPlan: { threadId, planId: "plan" },
      runtimeMode: "full-access",
      interactionMode: "default",
      createdAt: NOW,
    };
    const hydrated = await Effect.runPromise(
      hydrateDeciderReadModel(withoutDeletedThreadDetails(model), command, read),
    );
    expect(read.mock.calls).toHaveLength(1);
    expect(hydrated.threads[0]?.proposedPlans).toEqual(original.threads[0]?.proposedPlans);
    expect(await outcome(hydrated, command)).toEqual(await outcome(model, command));
  });
});
