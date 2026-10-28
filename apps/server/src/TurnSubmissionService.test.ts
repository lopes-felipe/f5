import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  ThreadId,
  TurnId,
  type NextTurnQueueSubmitInput,
  type OrchestrationReadModel,
} from "@t3tools/contracts";
import { Effect, Layer } from "effect";
import { vi } from "vitest";
import {
  makeTurnSubmissionService,
  type TurnSubmissionDependencies,
} from "./TurnSubmissionService.ts";
import { ServerConfig } from "./config.ts";
import { SqlitePersistenceMemory } from "./persistence/Layers/Sqlite.ts";
import type { NextTurnQueueStoreShape } from "./nextTurnQueue/Services/NextTurnQueueStore.ts";

const testLayer = SqlitePersistenceMemory.pipe(
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "turn-submission-" })),
  Layer.provideMerge(NodeServices.layer),
);
const layer = it.layer(testLayer);

layer("TurnSubmissionService queue holds", (it) => {
  for (const [intent, source, allowResume, expected] of [
    ["auto", "human", true, true],
    ["queue-head", "human", true, false],
    ["queue-tail", "human", true, false],
    ["steer", "human", true, false],
    ["auto", "automation", true, false],
    ["auto", "human", false, false],
  ] as const) {
    it.effect(intent + "/" + source + "/allow-resume=" + allowResume, () =>
      Effect.gen(function* () {
        const threadId = ThreadId.makeUnsafe("service-queue-hold");
        const command = {
          type: "thread.turn.start",
          commandId: CommandId.makeUnsafe("service-command"),
          threadId,
          message: {
            messageId: MessageId.makeUnsafe("service-message"),
            role: "user",
            text: "hello",
            attachments: [],
          },
          provider: "codex",
          model: "gpt-5.5",
          runtimeMode: "full-access",
          interactionMode: "default",
          createdAt: "2026-01-01T00:00:00.000Z",
        } satisfies NextTurnQueueSubmitInput["command"];
        const snapshot = {} as never;
        const insertSubmission = vi.fn<NextTurnQueueStoreShape["insertSubmission"]>(() =>
          Effect.succeed({ kind: "created" as const, item: {} as never }),
        );
        const deps: TurnSubmissionDependencies = {
          nextTurnQueueStore: {
            getBySubmissionId: () => Effect.succeed(null),
            insertSubmission,
            settleSubmission: () => Effect.void,
          } as unknown as TurnSubmissionDependencies["nextTurnQueueStore"],
          awaitOrchestrationRuntimeForRoute: Effect.succeed({
            orchestrationEngine: {
              getReadModel: () =>
                Effect.succeed({
                  threads: [
                    {
                      id: threadId,
                      worktreePath: null,
                      runtimeMode: "full-access",
                      interactionMode: "default",
                      session: { activeTurnId: TurnId.makeUnsafe("active") },
                    },
                  ],
                } as unknown as OrchestrationReadModel),
            } as never,
            nextTurnQueueDispatcher: {
              getSnapshot: () => Effect.succeed(snapshot),
              notify: () => Effect.void,
              submitAndSettle: () =>
                Effect.succeed({
                  disposition: "queued" as const,
                  submissionId: CommandId.makeUnsafe("service-submission"),
                  itemId: CommandId.makeUnsafe("service-item"),
                  snapshot,
                }),
            } as never,
            projectSetupScriptRunner: {} as never,
            worktreeSetup: {} as never,
          }),
          git: {} as never,
          singleFlightBootstrap: (_id, _hash, run) => run,
          startWorktreeSetupSubmission: () => Effect.die("unexpected bootstrap"),
          runBootstrapTurnStart: () => Effect.die("unexpected bootstrap"),
          normalizeDispatchCommand: () => Effect.succeed(command),
          removePersistedTurnAttachments: () => Effect.void,
          releaseSentUploads: () => Effect.void,
        };
        yield* makeTurnSubmissionService(deps)(
          {
            submissionId: CommandId.makeUnsafe("service-submission"),
            command,
            intent,
          },
          { submissionSource: source, resumeQueue: allowResume },
        );
        assert.equal(insertSubmission.mock.calls.length, 1);
        const admitted = insertSubmission.mock.calls[0]![0];
        assert.equal(admitted.resumeQueue, expected);
        assert.equal(admitted.submissionSource, source);
      }),
    );
  }
});
