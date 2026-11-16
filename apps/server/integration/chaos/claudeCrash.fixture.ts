/** A killable F5 process using the real Claude adapter and a scripted SDK query. */
import { createInterface } from "node:readline";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { CommandId, MessageId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { Effect, Layer } from "effect";
import { ServerConfig } from "../../src/config.ts";
import { makeClaudeAdapter } from "../../src/provider/Layers/ClaudeAdapter.ts";
import { FakeClaudeQuery } from "../../src/provider/testUtils/FakeClaudeQuery.ts";
import {
  makeOrchestrationIntegrationHarness,
  seedOrchestrationProjectAndThread,
} from "../OrchestrationEngineHarness.integration.ts";
import { makeClientTransport } from "./transport.ts";

const rootDir = process.argv[2]!;
const sessionId = "550e8400-e29b-41d4-a716-446655440000";
const threadId = ThreadId.makeUnsafe("thread-1");
const report = (value: unknown) => process.stdout.write(`F5_CHAOS:${JSON.stringify(value)}\n`);
const configDir = path.join(rootDir, "claude");
const transcriptDir = path.join(configDir, "projects", "fixture");
mkdirSync(transcriptDir, { recursive: true });
const transcript = path.join(transcriptDir, `${sessionId}.jsonl`);
const cursorFile = path.join(rootDir, "cursor.json");
await Effect.runPromise(
  Effect.scoped(
    Effect.gen(function* () {
      const queries: FakeClaudeQuery[] = [];
      const adapter = yield* makeClaudeAdapter({
        processEnvironment: { ...process.env, CLAUDE_CONFIG_DIR: configDir },
        probeResumableClaudeSession: () => Effect.succeed("present"),
        resumeConfirmationTimeoutMs: 0,
        createQuery: () => {
          const query = new FakeClaudeQuery();
          queries.push(query);
          return query;
        },
      });
      const harness = yield* Effect.acquireRelease(
        makeOrchestrationIntegrationHarness({ rootDir, adapter }),
        (harness) => harness.dispose,
      );
      const transport = yield* makeClientTransport(harness);
      const input = createInterface({ input: process.stdin });
      yield* Effect.addFinalizer(() => Effect.sync(() => input.close()));
      input.on("line", (line) => {
        const { method } = JSON.parse(line);
        const operation = Effect.gen(function* () {
          switch (method) {
            case "seed":
              return yield* seedOrchestrationProjectAndThread(harness);
            case "dispatch":
              return yield* harness.engine.dispatch({
                type: "thread.turn.start",
                commandId: CommandId.makeUnsafe("claude-crash-turn"),
                threadId,
                message: {
                  messageId: MessageId.makeUnsafe("claude-user"),
                  role: "user",
                  text: "work",
                  attachments: [],
                },
                modelSelection: {
                  instanceId: ProviderInstanceId.make("claudeAgent"),
                  model: "claude-sonnet-4-6",
                  options: [],
                },
                assistantDeliveryMode: "streaming",
                runtimeMode: "approval-required",
                interactionMode: "default",
                createdAt: new Date().toISOString(),
              });
            case "stream": {
              yield* harness.waitForThread(
                threadId,
                (thread) => thread.session?.status === "running",
              );
              const query = queries[0]!;
              const emit = (value: Record<string, unknown>) =>
                query.emit({
                  uuid: crypto.randomUUID(),
                  session_id: sessionId,
                  ...value,
                } as unknown as SDKMessage);
              emit({ type: "system", subtype: "init", model: "claude-sonnet-4-6" });
              emit({
                type: "stream_event",
                parent_tool_use_id: null,
                event: {
                  type: "content_block_start",
                  index: 0,
                  content_block: { type: "text", text: "" },
                },
              });
              emit({
                type: "stream_event",
                parent_tool_use_id: null,
                event: {
                  type: "content_block_delta",
                  index: 0,
                  delta: { type: "text_delta", text: "\nClaude prefix " },
                },
              });
              yield* harness.waitForThread(threadId, (thread) =>
                thread.messages.some((message) => message.text === "\nClaude prefix "),
              );
              // The native transcript has text whose SDK notification had not reached
              // F5 when it died. A coalescer needs the same recovery guarantee.
              writeFileSync(
                transcript,
                [
                  {
                    type: "user",
                    uuid: "123e4567-e89b-42d3-a456-426614174000",
                    parentUuid: null,
                    sessionId,
                    message: { role: "user", content: "work" },
                  },
                  {
                    type: "assistant",
                    uuid: "123e4567-e89b-42d3-a456-426614174001",
                    parentUuid: "123e4567-e89b-42d3-a456-426614174000",
                    sessionId,
                    message: {
                      role: "assistant",
                      content: [{ type: "text", text: "\nClaude prefix recovered suffix  \n" }],
                    },
                  },
                ]
                  .map((entry) => JSON.stringify(entry))
                  .join("\n") + "\n",
              );
              const session = (yield* adapter.listSessions())[0]!;
              writeFileSync(cursorFile, JSON.stringify(session.resumeCursor));
              return { cursor: session.resumeCursor };
            }
            case "resume": {
              const cursor = JSON.parse(readFileSync(cursorFile, "utf8"));
              yield* harness.providerService.startSession(threadId, {
                threadId,
                provider: "claudeAgent",
                runtimeMode: "approval-required",
                cwd: harness.workspaceDir,
                resumeCursor: cursor,
              });
              const history = yield* harness.providerService.readThread(threadId);
              return { history, state: yield* harness.engine.getReadModel() };
            }
            case "state":
              return yield* harness.engine.getReadModel();
            default:
              throw new Error(`Unknown command ${method}`);
          }
        });
        void Effect.runPromise(operation).then(
          (value) => report({ type: method, value }),
          (error) => report({ type: "failure", message: String(error) }),
        );
      });
      report({ type: "ready", url: transport.url });
      return yield* Effect.never;
    }),
  ).pipe(
    Effect.provide(
      ServerConfig.layerTest(rootDir, path.join(rootDir, "state")).pipe(
        Layer.provideMerge(NodeServices.layer),
      ),
    ),
  ),
);
