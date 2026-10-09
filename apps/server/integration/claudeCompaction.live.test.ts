import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { query } from "@anthropic-ai/claude-agent-sdk";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ThreadId, type ProviderRuntimeEvent, type NativeOperationInput } from "@t3tools/contracts";
import { Effect, Fiber, Layer, Stream } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { describe, expect, it, vi } from "vitest";
import { ServerConfig } from "../src/config.ts";
import {
  makeClaudeAdapterLive,
  resolveClaudeConfigDir,
} from "../src/provider/Layers/ClaudeAdapter.ts";
import { ClaudeAdapter } from "../src/provider/Services/ClaudeAdapter.ts";
import {
  makeNativeOperationCoordinator,
  nativeOperationSqlRepository,
} from "../src/provider/nativeOperations.ts";
import { makeSqlitePersistenceLive } from "../src/persistence/Layers/Sqlite.ts";
import { deleteClaudeSessionTranscript } from "../src/provider/claudeSessionCleanup.ts";
import { findClaudeTranscript, readClaudeTranscript } from "../src/provider/claudeTranscript.ts";

// This neutral environment deliberately retains the selected instance's home and
// credential routing. It must never borrow another profile's Claude account.
const environment = Object.fromEntries(
  Object.entries(process.env).filter(
    ([key]) =>
      [
        "HOME",
        "USERPROFILE",
        "APPDATA",
        "LOCALAPPDATA",
        "PATH",
        "SYSTEMROOT",
        "TEMP",
        "TMP",
        "TMPDIR",
        "CLAUDE_CONFIG_DIR",
        "CLAUDE_CODE_OAUTH_TOKEN",
        "NODE_EXTRA_CA_CERTS",
        "HTTPS_PROXY",
        "HTTP_PROXY",
        "NO_PROXY",
      ].includes(key) ||
      key.startsWith("ANTHROPIC_") ||
      key.startsWith("AWS_") ||
      key === "CLAUDE_CODE_USE_BEDROCK",
  ),
);

// Explicit opt-in. Authentication/quota failures fail; they never certify a runtime.
describe.skipIf(process.env.F5_CLAUDE_LIVE_TEST !== "1")(
  "F5 Claude native compaction acceptance",
  () => {
    it("settles the adapter operation durably and resumes the compacted transcript twice", async () => {
      const cwd = await mkdtemp(join(tmpdir(), "f5-claude-compact-"));
      const configDir = resolveClaudeConfigDir(environment, cwd);
      const threadId = ThreadId.makeUnsafe(randomUUID());
      const token = `F5_COMPACT_${randomUUID().replaceAll("-", "")}`;
      const children: ChildProcess[] = [];
      const closed = new Set<ChildProcess>();
      let sessionId: string | undefined;
      const layer = Layer.mergeAll(
        makeClaudeAdapterLive({
          processEnvironment: environment,
          createQuery: (input) =>
            query({
              prompt: input.prompt,
              options: {
                ...input.options,
                tools: [],
                spawnClaudeCodeProcess: (options) => {
                  const child = spawn(options.command, options.args, {
                    cwd: options.cwd,
                    env: options.env,
                    signal: options.signal,
                    stdio: ["pipe", "pipe", "pipe"],
                    windowsHide: true,
                  });
                  children.push(child);
                  child.once("close", () => closed.add(child));
                  return child;
                },
              },
            }),
        }),
        makeSqlitePersistenceLive(join(cwd, "operations.sqlite")),
      ).pipe(
        Layer.provideMerge(ServerConfig.layerTest(cwd, cwd)),
        Layer.provideMerge(NodeServices.layer),
      );
      try {
        await Effect.runPromise(
          Effect.gen(function* () {
            const adapter = yield* ClaudeAdapter;
            const sql = yield* SqlClient;
            const repository = nativeOperationSqlRepository(sql);
            const coordinator = makeNativeOperationCoordinator(repository);
            const events: ProviderRuntimeEvent[] = [];
            const listener = yield* Stream.runForEach(adapter.streamEvents, (event) =>
              Effect.sync(() => events.push(event)),
            ).pipe(Effect.forkChild);
            const model = process.env.F5_CLAUDE_COMPACTION_MODEL ?? "claude-fable-5-1";
            const start = (resumeCursor?: unknown) =>
              adapter.startSession({
                threadId,
                provider: "claudeAgent",
                cwd,
                model,
                runtimeMode: "approval-required",
                ...(resumeCursor ? { resumeCursor } : {}),
              });
            const turn = (input: string) =>
              Effect.gen(function* () {
                const count = events.filter((event) => event.type === "turn.completed").length;
                const offset = events.length;
                yield* adapter.sendTurn({ threadId, input, attachments: [] });
                yield* Effect.promise(() =>
                  vi.waitFor(
                    () => {
                      const completed = events.filter((event) => event.type === "turn.completed");
                      expect(completed.length).toBeGreaterThan(count);
                    },
                    { timeout: 60_000, interval: 50 },
                  ),
                );
                const completed = events.filter((event) => event.type === "turn.completed").at(-1)!;
                expect(completed.payload.state, completed.payload.errorMessage).toBe("completed");
                return events
                  .slice(offset)
                  .flatMap((event) => (event.type === "content.delta" ? [event.payload.delta] : []))
                  .join("");
              });
            try {
              const session = yield* start();
              sessionId = (session.resumeCursor as { resume: string }).resume;
              yield* turn(
                `Remember this important recovery token for future turns and summaries: ${token}. Reply READY.`,
              );
              const input: NativeOperationInput = {
                threadId,
                generation: 1,
                operationId: randomUUID(),
                command: { kind: "compact" },
              };
              let applied = false;
              const operation = yield* coordinator.execute(input, {
                validate: Effect.gen(function* () {
                  expect((yield* adapter.getSessionDiscovery!(threadId))?.nativeCompaction).toBe(
                    true,
                  );
                }),
                generation: Effect.succeed(1),
                dispatch: adapter.executeNativeOperation!(input),
                dispatchWithReceipt: (receipt) =>
                  adapter.executeNativeOperation!(input, (value) =>
                    Effect.runPromise(receipt(value)),
                  ),
                apply: () =>
                  Effect.sync(() => {
                    applied = true;
                  }),
              });
              expect(operation.state, operation.error).toBe("completed");
              expect(applied).toBe(true);
              expect((yield* repository.get(input.operationId))?.receipt).toMatchObject({
                nativeSessionId: sessionId,
                operationId: input.operationId,
              });
              expect(
                events.some(
                  (event) =>
                    event.type === "thread.state.changed" && event.payload.state === "compacted",
                ),
              ).toBe(true);
              const transcript = yield* Effect.promise(async () =>
                readClaudeTranscript(await findClaudeTranscript(configDir, sessionId!)),
              );
              expect(
                [...transcript.values()].some(
                  (entry) => entry.type === "system" && entry.subtype === "compact_boundary",
                ),
              ).toBe(true);
              for (let attempt = 0; attempt < 2; attempt++) {
                const cursor = (yield* adapter.listSessions())[0]!.resumeCursor;
                if (attempt === 0) expect(cursor).toMatchObject({ resumeLatest: true });
                yield* adapter.stopSession(threadId);
                yield* start(cursor);
                expect(
                  yield* turn(
                    "Reply with the exact recovery token from earlier, and nothing else.",
                  ),
                ).toContain(token);
              }
            } finally {
              yield* adapter.stopAll();
              yield* Fiber.interrupt(listener);
            }
          }).pipe(Effect.scoped, Effect.provide(layer), Effect.timeout("170 seconds")),
        );
      } finally {
        try {
          await expect.poll(() => closed.size, { timeout: 5000 }).toBe(children.length);
          if (sessionId)
            await deleteClaudeSessionTranscript({ sessionId, claudeConfigDir: configDir });
        } finally {
          await rm(cwd, { recursive: true, force: true });
        }
      }
    }, 180_000);
  },
);
