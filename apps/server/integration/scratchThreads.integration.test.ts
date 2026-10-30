import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { assert, it } from "@effect/vitest";
import { CommandId, EventId, MessageId, ProjectId, ThreadId, TurnId } from "@t3tools/contracts";
import { Effect } from "effect";

import {
  makeOrchestrationIntegrationHarness,
  type OrchestrationIntegrationHarness,
} from "./OrchestrationEngineHarness.integration.ts";

const projectId = ProjectId.makeUnsafe("scratch");
const threadIds = [ThreadId.makeUnsafe("scratch-one"), ThreadId.makeUnsafe("scratch-two")];

function send(h: OrchestrationIntegrationHarness, threadId: ThreadId, turn: number) {
  return Effect.gen(function* () {
    const stamp = new Date().toISOString();
    const turnId = `${threadId}-turn-${turn}`;
    const response = {
      turnId: TurnId.makeUnsafe(turnId),
      events: [
        {
          type: "turn.started",
          eventId: EventId.makeUnsafe(`${turnId}-started`),
          provider: "codex" as const,
          createdAt: stamp,
          threadId,
          turnId,
        },
        {
          type: "message.delta",
          eventId: EventId.makeUnsafe(`${turnId}-reply`),
          provider: "codex" as const,
          createdAt: stamp,
          threadId,
          turnId,
          delta: `Reply ${turn}`,
        },
        {
          type: "turn.completed",
          eventId: EventId.makeUnsafe(`${turnId}-completed`),
          provider: "codex" as const,
          createdAt: stamp,
          threadId,
          turnId,
          status: "completed",
        },
      ],
    };
    if (h.adapterHarness!.listActiveSessionIds().includes(threadId)) {
      yield* h.adapterHarness!.queueTurnResponse(threadId, response);
    } else {
      yield* h.adapterHarness!.queueTurnResponseForNextSession(response);
    }
    yield* h.engine.dispatch({
      type: "thread.turn.start",
      commandId: CommandId.makeUnsafe(turnId),
      threadId,
      message: {
        messageId: MessageId.makeUnsafe(`${turnId}-user`),
        role: "user",
        text: "Research a topic",
        attachments: [],
      },
      provider: "codex",
      interactionMode: "default",
      runtimeMode: "full-access",
      createdAt: stamp,
    });
    return yield* h.waitForThread(
      threadId,
      (thread) =>
        thread.session?.status === "ready" &&
        thread.latestTurn?.state === "completed" &&
        thread.messages.some(
          (message) =>
            message.role === "assistant" && !message.streaming && message.text === `Reply ${turn}`,
        ),
    );
  });
}

it.live(
  "keeps independent scratch workspaces across first send, follow-up, restart and reopen",
  () =>
    Effect.gen(function* () {
      const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "f5-scratch-integration-"));
      const folders = new Map<ThreadId, string>();
      const withRuntime = <A, E>(
        use: (h: OrchestrationIntegrationHarness) => Effect.Effect<A, E>,
      ) =>
        Effect.acquireUseRelease(
          makeOrchestrationIntegrationHarness({ rootDir }),
          use,
          (h) => h.dispose,
        );
      try {
        yield* withRuntime((h) =>
          Effect.gen(function* () {
            yield* h.engine.dispatch({
              type: "project.scratch.create",
              commandId: CommandId.makeUnsafe("scratch-create"),
              projectId,
              workspaceRoot: path.join(rootDir, "state", "scratch"),
              createdAt: new Date().toISOString(),
            });
            for (const threadId of threadIds) {
              yield* h.engine.dispatch({
                type: "thread.create",
                commandId: CommandId.makeUnsafe(`create-${threadId}`),
                threadId,
                projectId,
                title: "Research",
                scratchFolderWords: "Research a topic",
                model: "gpt-5.5",
                runtimeMode: "full-access",
                interactionMode: "default",
                branch: null,
                worktreePath: null,
                createdAt: new Date().toISOString(),
              });
              const first = yield* send(h, threadId, 1);
              assert.isString(first.scratchPath);
              folders.set(threadId, first.scratchPath!);
              fs.writeFileSync(path.join(first.scratchPath!, "notes.txt"), String(threadId));
              const followup = yield* send(h, threadId, 2);
              assert.equal(followup.scratchPath, first.scratchPath);
              assert.isNull(followup.branch);
              assert.isNull(followup.worktreePath);
              assert.isFalse(fs.existsSync(path.join(first.scratchPath!, ".git")));
              assert.deepEqual(yield* h.checkpointRepository.listByThreadId({ threadId }), []);
            }
            assert.equal(new Set(folders.values()).size, 2);
          }),
        );
        yield* withRuntime((h) =>
          Effect.gen(function* () {
            for (const threadId of threadIds) {
              const reopened = yield* send(h, threadId, 3);
              assert.equal(reopened.scratchPath, folders.get(threadId));
              assert.equal(
                fs.readFileSync(path.join(reopened.scratchPath!, "notes.txt"), "utf8"),
                threadId,
              );
              const session = (yield* h.providerService.listSessions()).find(
                (session) => session.threadId === threadId,
              );
              assert.equal(session?.cwd, reopened.scratchPath);
            }
            const model = yield* h.engine.getReadModel();
            assert.equal(model.projects.filter((project) => project.kind === "scratch").length, 1);
          }),
        );
      } finally {
        fs.rmSync(rootDir, { recursive: true, force: true });
      }
    }),
  60_000,
);
