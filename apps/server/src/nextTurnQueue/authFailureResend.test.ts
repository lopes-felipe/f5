import {
  MessageId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type OrchestrationCommand,
  type OrchestrationReadModel,
} from "@t3tools/contracts";
import { authFailureKey } from "@t3tools/shared/usageLimit";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { failedTurnUserMessage, resendAuthFailedTurn } from "./authFailureResend.ts";

const threadId = ThreadId.makeUnsafe("auth-thread");
const failure = {
  providerInstanceId: ProviderInstanceId.makeUnsafe("claude"),
  turnId: TurnId.makeUnsafe("failed-turn"),
  occurredAt: "2026-11-22T12:59:00.000Z",
};
const attachment = {
  type: "image" as const,
  id: "image-1",
  name: "shot.png",
  mimeType: "image/png",
  sizeBytes: 10,
};
const message = (id: string, turnId: string | null, text: string, createdAt: string) => ({
  id: MessageId.makeUnsafe(id),
  role: "user" as const,
  text,
  turnId: turnId ? TurnId.makeUnsafe(turnId) : null,
  streaming: false,
  createdAt,
  updatedAt: createdAt,
});

function makeEngine(sessionPatch: Record<string, unknown> = {}) {
  const dispatched: OrchestrationCommand[] = [];
  const thread = {
    id: threadId,
    model: "claude-opus-5-5",
    runtimeMode: "full-access",
    interactionMode: "default",
    deletedAt: null,
    archivedAt: null,
    messages: [
      message("earlier", "old-turn", "earlier", "2026-11-22T12:00:00.000Z"),
      {
        ...message("failed", "failed-turn", "test", "2026-11-22T12:58:57.000Z"),
        attachments: [attachment],
      },
    ],
    session: {
      threadId,
      status: "error",
      activeTurnId: null,
      authFailure: failure,
      ...sessionPatch,
    },
  };
  const readModel = { threads: [thread] } as unknown as OrchestrationReadModel;
  return {
    dispatched,
    engine: {
      getReadModel: () => Effect.succeed(readModel),
      dispatch: (command: OrchestrationCommand) =>
        Effect.sync(() => {
          dispatched.push(command);
          return { sequence: dispatched.length };
        }),
    },
  };
}

const key = authFailureKey(failure)!;
const run = (engine: ReturnType<typeof makeEngine>["engine"], expectedFailureKey = key) =>
  Effect.runPromise(
    resendAuthFailedTurn(
      engine,
      { threadId, expectedFailureKey },
      () => "2026-11-22T13:05:00.000Z",
    ),
  );

describe("resendAuthFailedTurn", () => {
  it("resends the failed turn's own message with its attachments under a failure-derived id", async () => {
    const { engine, dispatched } = makeEngine();
    expect(await run(engine)).toEqual({ kind: "sent" });
    expect(dispatched).toHaveLength(1);
    const command = dispatched[0] as Extract<OrchestrationCommand, { type: "thread.turn.start" }>;
    expect(command.type).toBe("thread.turn.start");
    expect(command.message.text).toBe("test");
    expect(command.message.attachments).toEqual([attachment]);
    expect(command.commandId).toBe(`auth-resend:${threadId}:${key}`);
    await run(engine);
    // The same failure always maps to the same command; receipts dedupe it.
    expect(dispatched[1]?.commandId).toBe(command.commandId);
  });

  it("refuses a stale failure key", async () => {
    const { engine, dispatched } = makeEngine();
    expect((await run(engine, "stale")).kind).toBe("ineligible");
    expect(dispatched).toHaveLength(0);
  });

  it("waits while the thread is busy", async () => {
    const { engine, dispatched } = makeEngine({ status: "running", activeTurnId: "other" });
    expect((await run(engine)).kind).toBe("busy");
    expect(dispatched).toHaveLength(0);
  });

  it("is ineligible without a recorded auth failure", async () => {
    const { engine } = makeEngine({ authFailure: null });
    expect((await run(engine)).kind).toBe("ineligible");
  });
});

describe("failedTurnUserMessage", () => {
  it("falls back to the last message before the failure when the turn id is unknown", () => {
    const picked = failedTurnUserMessage(
      {
        messages: [
          message("a", null, "first", "2026-11-22T12:00:00.000Z"),
          message("b", null, "second", "2026-11-22T12:58:00.000Z"),
          message("c", null, "after", "2026-11-22T13:30:00.000Z"),
        ],
      },
      { turnId: null, occurredAt: failure.occurredAt },
    );
    expect(picked?.text).toBe("second");
  });
});
