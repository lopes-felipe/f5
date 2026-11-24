import { writeAcpWrapper } from "../../testUtils/cli.ts";
import * as os from "node:os";
import * as path from "node:path";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createModelSelection } from "@t3tools/shared/model";
import { READ_ONLY_WORKFLOW_UNCERTIFIED_ANTIGRAVITY_MESSAGE } from "@t3tools/shared/workflowProviders";
import { fileURLToPath } from "node:url";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it, it as rootIt } from "@effect/vitest";
import {
  ApprovalRequestId,
  GrokSettings,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderRuntimeEvent,
  ThreadId,
  type TurnId,
} from "@t3tools/contracts";
import { Cause, Effect, Fiber, Layer, Schema, ServiceMap, Stream } from "effect";

import { vi } from "vitest";
import * as GrokAcpSupport from "../acp/GrokAcpSupport.ts";
import { ServerConfig } from "../../config.ts";
import type { GrokAdapterShape } from "../Services/GrokAdapter.ts";
import { makeGrokAdapter, type GrokAdapterLiveOptions } from "./GrokAdapter.ts";
import { TurnAcceptanceSignal } from "../deliveryAttemptContext.ts";
import type { InteractionSession } from "../../mcp/interactionMcpTools.ts";
import type { PreviewMcpHttpServerShape } from "../../mcp/PreviewMcpHttpServer.ts";

class GrokAdapter extends ServiceMap.Service<GrokAdapter, GrokAdapterShape>()(
  "t3/provider/Layers/GrokAdapter.test/GrokAdapter",
) {}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const mockAgentPath = path.join(__dirname, "../../../scripts/acp-mock-agent.ts");
const discoverHardeningSkills = vi.fn(() =>
  Effect.succeed([{ name: "deploy", description: "Deploy" }]),
);

const GrokAdapterHardeningTestLayer = Layer.effect(
  GrokAdapter,
  Effect.gen(function* () {
    const dir = yield* Effect.promise(() => mkdtemp(path.join(os.tmpdir(), "grok-acp-mock-")));
    const wrapperPath = writeAcpWrapper(path.join(dir, "fake-grok"), mockAgentPath, {
      env: { T3_ACP_PROMPT_DELAY_MS: "80", T3_ACP_LOAD_FAIL_NOT_FOUND: "1" },
    });
    const settings = Schema.decodeSync(GrokSettings)({ binaryPath: wrapperPath });
    return yield* makeGrokAdapter(settings, {
      discoverSkillCommands: discoverHardeningSkills,
    });
  }),
).pipe(
  Layer.provideMerge(
    ServerConfig.layerTest(
      process.cwd(),
      { prefix: "t3code-grok-adapter-hardening-test-" },
      { acpHardeningEnabled: true },
    ),
  ),
  Layer.provideMerge(NodeServices.layer),
);

it.layer(GrokAdapterHardeningTestLayer)("GrokAdapterLive ACP hardening", (it) => {
  it.effect(
    "classifies and sends leading catalog skills through the same native command path",
    () =>
      Effect.gen(function* () {
        const adapter = yield* GrokAdapter;
        const threadId = ThreadId.make("grok-picked-skill");
        const original = GrokAcpSupport.makeGrokAcpRuntime;
        const prompts: Array<unknown> = [];
        const spy = vi.spyOn(GrokAcpSupport, "makeGrokAcpRuntime").mockImplementation((input) =>
          original(input).pipe(
            Effect.map((runtime) => ({
              ...runtime,
              prompt: (input) => {
                prompts.push(input.prompt);
                return runtime.prompt(input);
              },
            })),
          ),
        );
        yield* Effect.addFinalizer(() => Effect.sync(() => spy.mockRestore()));
        const classification = adapter.classifyTurnInput!(threadId, "$deploy ship", process.cwd());
        assert.equal(
          yield* Effect.isEffect(classification) ? classification : Effect.succeed(classification),
          "native-command",
        );
        const probes = discoverHardeningSkills.mock.calls.length;
        assert.equal(adapter.classifyTurnInput!(threadId, "$25 budget", process.cwd()), "prompt");
        assert.equal(discoverHardeningSkills.mock.calls.length, probes);
        yield* adapter.startSession({
          threadId,
          provider: "grok",
          cwd: process.cwd(),
          runtimeMode: "full-access",
        });
        yield* adapter.sendTurn({ threadId, input: "$deploy ship", attachments: [] });
        assert.deepEqual(prompts[0], [{ type: "text", text: "/deploy ship" }]);
        discoverHardeningSkills.mockReturnValueOnce(Effect.succeed([]));
        const removed = adapter.classifyTurnInput!(threadId, "$deploy ship", process.cwd());
        assert.equal(yield* Effect.isEffect(removed) ? removed : Effect.succeed(removed), "prompt");
        yield* adapter.stopSession(threadId);
      }),
  );
  it.effect("classifies only a leading slash command as native for a provider switch", () =>
    Effect.gen(function* () {
      const adapter = yield* GrokAdapter;
      const threadId = ThreadId.makeUnsafe("grok-classify");
      assert.strictEqual(adapter.classifyTurnInput?.(threadId, "/compact"), "native-command");
      assert.strictEqual(
        adapter.classifyTurnInput?.(threadId, " /skill:review x"),
        "native-command",
      );
      assert.strictEqual(adapter.classifyTurnInput?.(threadId, "/Users/me/app.ts fails"), "prompt");
      assert.strictEqual(adapter.classifyTurnInput?.(threadId, "run /compact later"), "prompt");
    }),
  );

  it.effect("ignores a late prompt from an older context with the same resumed session ID", () =>
    Effect.gen(function* () {
      const original = GrokAcpSupport.makeGrokAcpRuntime;
      let release!: () => void;
      let oldSettled = false;
      let calls = 0;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const spy = vi.spyOn(GrokAcpSupport, "makeGrokAcpRuntime").mockImplementation((input) =>
        original(input).pipe(
          Effect.map((runtime) => ({
            ...runtime,
            prompt: (promptInput) => {
              const first = calls++ === 0;
              return runtime.prompt(promptInput).pipe(
                Effect.ensuring(
                  first
                    ? Effect.promise(async () => {
                        oldSettled = true;
                        await gate;
                      })
                    : Effect.void,
                ),
              );
            },
          })),
        ),
      );
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          release();
          spy.mockRestore();
        }),
      );
      {
        const adapter = yield* GrokAdapter;
        const threadId = ThreadId.make("same-native-session");
        const session = yield* adapter.startSession({
          threadId,
          provider: "grok",
          cwd: process.cwd(),
          runtimeMode: "full-access",
        });
        const old = yield* adapter
          .sendTurn({ threadId, input: "old", attachments: [] })
          .pipe(Effect.forkChild);
        while (!oldSettled)
          yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 1)));
        yield* adapter.interruptTurn(threadId);
        const resumed = yield* adapter.startSession({
          threadId,
          provider: "grok",
          cwd: process.cwd(),
          runtimeMode: "full-access",
          resumeCursor: session.resumeCursor,
        });
        assert.deepEqual(resumed.resumeCursor, session.resumeCursor);
        const completed = yield* adapter.streamEvents.pipe(
          Stream.filter((event) => event.type === "turn.completed"),
          Stream.runHead,
          Effect.forkChild,
        );
        const fresh = yield* adapter
          .sendTurn({ threadId, input: "new", attachments: [] })
          .pipe(Effect.forkChild);
        while (calls < 2) yield* Effect.yieldNow;
        release();
        yield* Fiber.join(old);
        yield* Fiber.join(fresh);
        const terminal = yield* Fiber.join(completed).pipe(Effect.timeout("2 seconds"));
        assert.equal(terminal._tag, "Some");
        yield* adapter.stopSession(threadId);
      }
    }).pipe(Effect.scoped),
  );
  it.effect("leaves an idle session alive on repeated Stop", () =>
    Effect.gen(function* () {
      const adapter = yield* GrokAdapter;
      const threadId = ThreadId.make("idle-stop");
      yield* adapter.startSession({
        threadId,
        provider: "grok",
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });
      yield* adapter.interruptTurn(threadId);
      yield* adapter.interruptTurn(threadId);
      assert.equal(yield* adapter.hasSession(threadId), true);
      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("stops the process and active turn even without a prompt cancellation response", () =>
    Effect.gen(function* () {
      const adapter = yield* GrokAdapter;
      const threadId = ThreadId.make("grok-stop-prompt");
      const events: ProviderRuntimeEvent[] = [];
      const fiber = yield* adapter.streamEvents.pipe(
        Stream.runForEach((event) =>
          Effect.sync(() => {
            events.push(event);
          }),
        ),
        Effect.forkChild,
      );
      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("grok"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });
      const prompt = yield* adapter
        .sendTurn({ threadId, input: "keep working", attachments: [] })
        .pipe(Effect.forkChild);
      yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 10)));
      yield* adapter.interruptTurn(threadId);
      yield* Fiber.await(prompt);
      yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 10)));
      assert.equal(
        events.filter(
          (event) => event.type === "turn.completed" && event.payload.state === "cancelled",
        ).length,
        1,
      );
      assert.equal(events.filter((event) => event.type === "session.exited").length, 1);
      yield* adapter.interruptTurn(threadId);
      yield* Fiber.interrupt(fiber);
    }),
  );
  it.effect("threads resume cursors through the hardened load fallback", () =>
    Effect.gen(function* () {
      const adapter = yield* GrokAdapter;
      const threadId = ThreadId.make("grok-resume-hardening");

      const session = yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("grok"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
        modelSelection: { instanceId: ProviderInstanceId.make("grok"), model: "grok-build" },
        resumeCursor: { schemaVersion: 1, sessionId: "missing-session" },
      });

      assert.deepStrictEqual(session.resumeCursor, {
        schemaVersion: 1,
        sessionId: "mock-session-1",
      });
      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("keeps overlapping prompts steered into one active turn", () =>
    Effect.gen(function* () {
      const adapter = yield* GrokAdapter;
      const threadId = ThreadId.make("grok-overlapping-steering-hardening");
      const events: ProviderRuntimeEvent[] = [];
      const eventFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.sync(() => {
          events.push(event);
        }),
      ).pipe(Effect.forkScoped);

      const startup = yield* adapter
        .startSession({
          threadId,
          provider: ProviderDriverKind.make("grok"),
          cwd: process.cwd(),
          runtimeMode: "full-access",
          modelSelection: { instanceId: ProviderInstanceId.make("grok"), model: "grok-build" },
        })
        .pipe(Effect.forkChild);
      yield* Fiber.join(startup);

      const first = yield* adapter
        .sendTurn({ threadId, input: "first", attachments: [] })
        .pipe(Effect.forkChild);
      yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 10)));
      const second = yield* adapter
        .sendTurn({ threadId, input: "second", attachments: [] })
        .pipe(Effect.forkChild);
      const [firstResult, secondResult] = yield* Effect.all(
        [Fiber.join(first), Fiber.join(second)],
        {
          concurrency: "unbounded",
        },
      );
      yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 20)));

      assert.equal(firstResult.turnId, secondResult.turnId);
      const turnStarted = events.filter((event) => event.type === "turn.started");
      const turnCompleted = events.filter((event) => event.type === "turn.completed");
      assert.ok(events.some((event) => event.type === "content.delta"));
      assert.equal(turnStarted.length, 1);
      assert.equal(turnCompleted.length, 1);
      assert.equal(turnCompleted[0]?.turnId, firstResult.turnId);

      yield* adapter.stopSession(threadId);
      yield* Fiber.interrupt(eventFiber);
    }),
  );
});

const AntigravityAdapterTestLayer = Layer.effect(
  GrokAdapter,
  Effect.gen(function* () {
    const dir = yield* Effect.promise(() =>
      mkdtemp(path.join(os.tmpdir(), "antigravity-acp-mock-")),
    );
    const wrapperPath = writeAcpWrapper(path.join(dir, "fake-antigravity"), mockAgentPath, {
      env: { F5_ACP_ANTIGRAVITY_QUESTION: "1", F5_ACP_STARTUP_COMMANDS: "1" },
    });
    return yield* makeGrokAdapter(Schema.decodeSync(GrokSettings)({ binaryPath: wrapperPath }), {
      provider: "antigravity",
      instanceId: ProviderInstanceId.make("antigravity"),
    });
  }),
).pipe(
  Layer.provideMerge(
    ServerConfig.layerTest(
      process.cwd(),
      { prefix: "f5-agy-adapter-test-" },
      { acpHardeningEnabled: true },
    ),
  ),
  Layer.provideMerge(NodeServices.layer),
);

it.layer(AntigravityAdapterTestLayer)("Antigravity native questions", (it) => {
  rootIt.live("retires a silent prompt and starts a fresh runtime on the next message", () =>
    Effect.gen(function* () {
      const dir = yield* Effect.promise(() =>
        mkdtemp(path.join(os.tmpdir(), "antigravity-inactive-")),
      );
      const wrapperPath = writeAcpWrapper(path.join(dir, "agent"), mockAgentPath, {});
      let starts = 0;
      let live = 0;
      const adapter = yield* makeGrokAdapter(
        Schema.decodeSync(GrokSettings)({ binaryPath: wrapperPath }),
        {
          provider: "antigravity",
          promptInactivityTimeoutMs: 100,
          makeRuntime: (input) =>
            Effect.gen(function* () {
              starts++;
              live++;
              yield* Effect.addFinalizer(() =>
                Effect.sync(() => {
                  live--;
                }),
              );
              return yield* GrokAcpSupport.makeGrokAcpRuntime(input);
            }),
        },
      );
      const threadId = ThreadId.make("antigravity-inactive");
      const input = {
        threadId,
        provider: "antigravity" as const,
        cwd: process.cwd(),
        runtimeMode: "full-access" as const,
      };
      yield* adapter.startSession(input);
      const result = yield* adapter
        .sendTurn({ threadId, input: "silent-inactivity-test", attachments: [] })
        .pipe(Effect.exit);
      assert.isTrue(result._tag === "Failure");
      assert.equal(
        live,
        0,
        result._tag === "Failure" ? Cause.pretty(result.cause) : "unexpected success",
      );
      yield* adapter.startSession(input);
      // Allow the normal fixture turn to finish without using the accelerated deadline.
      yield* adapter.sendTurn({ threadId, input: "continue", attachments: [] });
      assert.equal(starts, 2);
      yield* adapter.stopSession(threadId);
      assert.equal(live, 0);
    }).pipe(Effect.provide(AntigravityAdapterTestLayer), Effect.scoped),
  );
  rootIt.live(
    "declines questions and forms on an unattended workflow turn instead of waiting",
    () =>
      Effect.gen(function* () {
        const dir = yield* Effect.promise(() =>
          mkdtemp(path.join(os.tmpdir(), "antigravity-unattended-")),
        );
        const wrapperPath = writeAcpWrapper(path.join(dir, "agent"), mockAgentPath, {
          env: {
            F5_ACP_ANTIGRAVITY_PROFILE: "1",
            F5_ACP_ANTIGRAVITY_ELICIT: "1",
            F5_ACP_ANTIGRAVITY_QUESTION: "1",
          },
        });
        const adapter = yield* makeGrokAdapter(
          Schema.decodeSync(GrokSettings)({ binaryPath: wrapperPath }),
          {
            provider: "antigravity",
            instanceId: ProviderInstanceId.make("antigravity"),
            antigravity: { readOnlyWorkflowCertified: () => true },
          },
        );
        const events: ProviderRuntimeEvent[] = [];
        yield* adapter.streamEvents.pipe(
          Stream.runForEach((event) =>
            Effect.sync(() => {
              events.push(event);
            }),
          ),
          Effect.forkChild,
        );
        const threadId = ThreadId.make("antigravity-unattended");
        yield* adapter.startSession({
          threadId,
          provider: "antigravity",
          cwd: process.cwd(),
          runtimeMode: "full-access",
          workflowExecutionProfile: "unattended-readonly",
        });
        // Completes without anyone answering: both requests are declined at once.
        yield* adapter
          .sendTurn({
            threadId,
            input: "Ask first",
            attachments: [],
            workflowExecutionProfile: "unattended-readonly",
          })
          .pipe(Effect.timeout("20 seconds"));
        assert.ok(
          events.some(
            (event) =>
              event.type === "runtime.warning" &&
              event.payload.message.includes("unattended workflow turn"),
          ),
        );
        const requested = events.filter((event) => event.type === "user-input.requested");
        const resolved = events.filter((event) => event.type === "user-input.resolved");
        assert.equal(requested.length, 1);
        assert.equal(resolved.length, 1);
        yield* adapter.stopSession(threadId);
      }).pipe(Effect.provide(AntigravityAdapterTestLayer), Effect.scoped),
  );
  rootIt.live("refuses workflow sessions on an uncertified or unknown Antigravity build", () =>
    Effect.gen(function* () {
      const dir = yield* Effect.promise(() =>
        mkdtemp(path.join(os.tmpdir(), "antigravity-uncertified-")),
      );
      const wrapperPath = writeAcpWrapper(path.join(dir, "agent"), mockAgentPath, {
        env: { F5_ACP_ANTIGRAVITY_PROFILE: "1" },
      });
      const settings = Schema.decodeSync(GrokSettings)({ binaryPath: wrapperPath });
      const startWorkflowSession = (
        adapter: Effect.Success<ReturnType<typeof makeGrokAdapter>>,
        threadId: string,
      ) =>
        adapter.startSession({
          threadId: ThreadId.make(threadId),
          provider: "antigravity",
          cwd: process.cwd(),
          runtimeMode: "full-access",
          workflowExecutionProfile: "unattended-readonly",
        });

      // No launched version is known here and the allowlist is empty: uncertified.
      const defaultAdapter = yield* makeGrokAdapter(settings, {
        provider: "antigravity",
        instanceId: ProviderInstanceId.make("antigravity"),
      });
      const refused = yield* Effect.flip(startWorkflowSession(defaultAdapter, "uncertified"));
      assert.include(String(refused.message), READ_ONLY_WORKFLOW_UNCERTIFIED_ANTIGRAVITY_MESSAGE);

      const seenVersions: Array<string | undefined> = [];
      const rejectingAdapter = yield* makeGrokAdapter(settings, {
        provider: "antigravity",
        instanceId: ProviderInstanceId.make("antigravity"),
        antigravity: {
          readOnlyWorkflowCertified: (version) => {
            seenVersions.push(version);
            return false;
          },
        },
      });
      yield* Effect.flip(startWorkflowSession(rejectingAdapter, "rejected-by-hook"));
      assert.deepEqual(seenVersions, [undefined]);

      // An ordinary session is not gated, but it never takes a workflow turn.
      yield* defaultAdapter.startSession({
        threadId: ThreadId.make("ordinary"),
        provider: "antigravity",
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });
      const workflowTurn = yield* Effect.flip(
        defaultAdapter.sendTurn({
          threadId: ThreadId.make("ordinary"),
          input: "Review this",
          attachments: [],
          workflowExecutionProfile: "unattended-readonly",
        }),
      );
      assert.include(
        String(workflowTurn.message),
        "This Antigravity session was not started for read-only workflow turns.",
      );
      yield* defaultAdapter.stopSession(ThreadId.make("ordinary"));
    }).pipe(Effect.provide(AntigravityAdapterTestLayer), Effect.scoped),
  );
  it.effect("waits for the user's answer even in full-access mode", () =>
    Effect.gen(function* () {
      const adapter = yield* GrokAdapter;
      const threadId = ThreadId.make("antigravity-question");
      let question: Extract<ProviderRuntimeEvent, { type: "user-input.requested" }> | undefined;
      const events: ProviderRuntimeEvent[] = [];
      yield* adapter.streamEvents.pipe(
        Stream.runForEach((event) =>
          Effect.sync(() => {
            events.push(event);
            if (event.type === "user-input.requested") question = event;
          }),
        ),
        Effect.forkChild,
      );
      yield* adapter.startSession({
        threadId,
        provider: "antigravity",
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });
      const turn = yield* adapter
        .sendTurn({ threadId, input: "Ask first", attachments: [] })
        .pipe(Effect.forkChild);
      yield* Effect.promise(() => vi.waitFor(() => assert.ok(question)));
      assert.equal(
        events.some((event) => event.type === "turn.completed"),
        false,
      );
      const request = question!;
      assert.equal(request.payload.questions[0]?.allowCustomAnswer, false);
      assert.deepEqual(
        request.payload.questions[0]?.options.map((option) => option.value),
        ["dev", "prod"],
      );
      yield* adapter.respondToUserInput(threadId, ApprovalRequestId.make(request.requestId!), {
        interaction_test: "dev",
      });
      yield* Fiber.join(turn);
      assert.equal(events.filter((event) => event.type === "user-input.resolved").length, 1);
      yield* adapter.stopSession(threadId);
    }),
  );
  it.effect("retains native commands published before session creation returns", () =>
    Effect.gen(function* () {
      const adapter = yield* GrokAdapter;
      const threadId = ThreadId.make("startup-commands");
      const configured: ProviderRuntimeEvent[] = [];
      yield* adapter.streamEvents.pipe(
        Stream.runForEach((event) =>
          Effect.sync(() => {
            configured.push(event);
          }),
        ),
        Effect.forkChild,
      );
      yield* adapter.startSession({
        threadId,
        provider: "antigravity",
        cwd: process.cwd(),
        runtimeMode: "approval-required",
      });
      yield* Effect.promise(() =>
        vi.waitFor(() =>
          assert.ok(
            configured.some(
              (event) =>
                event.type === "session.configured" &&
                JSON.stringify(event.payload).includes("Review changes"),
            ),
          ),
        ),
      );
      assert.equal(
        configured.some(
          (event) =>
            event.type === "session.configured" &&
            JSON.stringify(event.payload).includes("Compact session"),
        ),
        false,
      );
      yield* adapter.stopSession(threadId);
    }),
  );
  it.effect("keeps native compaction disabled by default", () =>
    Effect.gen(function* () {
      const adapter = yield* GrokAdapter;
      const threadId = ThreadId.make("antigravity-no-compact");
      yield* adapter.startSession({
        threadId,
        provider: "antigravity",
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });
      const result = yield* adapter
        .sendTurn({ threadId, input: "/compact", attachments: [] })
        .pipe(Effect.result);
      assert.equal(result._tag, "Failure");
      yield* adapter.stopSession(threadId);
    }),
  );
});

const antigravityProfileAdapter = (input: {
  readonly env?: Record<string, string> | ((dir: string) => Record<string, string>);
  readonly accountRevision?: number;
  readonly credentials?: ReadonlyArray<string>;
  readonly staleAccount?: () => string | undefined;
  readonly options?: (dir: string) => Partial<GrokAdapterLiveOptions>;
}) =>
  Effect.gen(function* () {
    // Removed when the test's scope closes, also after a failed setup or assertion.
    const dir = yield* Effect.acquireRelease(
      Effect.promise(() => mkdtemp(path.join(os.tmpdir(), "agy-profile-"))),
      (directory) => Effect.promise(() => rm(directory, { recursive: true, force: true })),
    );
    const requestLogPath = path.join(dir, "requests.ndjson");
    const wrapperPath = writeAcpWrapper(path.join(dir, "agent"), mockAgentPath, {
      env: {
        F5_ACP_ANTIGRAVITY_PROFILE: "1",
        T3_ACP_REQUEST_LOG_PATH: requestLogPath,
        ...(typeof input.env === "function" ? input.env(dir) : input.env),
      },
    });
    const adapter = yield* makeGrokAdapter(
      Schema.decodeSync(GrokSettings)({ binaryPath: wrapperPath }),
      {
        provider: "antigravity",
        instanceId: ProviderInstanceId.make("antigravity"),
        antigravity: {
          accountRevision: Effect.succeed(input.accountRevision ?? 0),
          ...(input.credentials ? { credentials: input.credentials } : {}),
          ...(input.staleAccount ? { staleAccount: Effect.sync(input.staleAccount) } : {}),
          nativeReaders: () => Effect.succeed(false),
        },
        ...input.options?.(dir),
      },
    );
    const requests = () =>
      Effect.promise(async () =>
        (await readFile(requestLogPath, "utf8").catch(() => ""))
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line) as { method?: string; params?: Record<string, unknown> }),
      );
    const events: ProviderRuntimeEvent[] = [];
    yield* adapter.streamEvents.pipe(
      Stream.runForEach((event) => Effect.sync(() => events.push(event))),
      Effect.forkChild,
    );
    return { adapter, requests, events };
  });

const antigravityModelSelection = (model: string, thinking?: string) =>
  createModelSelection(
    ProviderInstanceId.make("antigravity"),
    model,
    thinking ? [{ id: "thinking", value: thinking }] : [],
  );

rootIt.layer(
  ServerConfig.layerTest(process.cwd(), { prefix: "f5-agy-profile-test-" }).pipe(
    Layer.provideMerge(NodeServices.layer),
  ),
)("Antigravity session control", (it) => {
  it.effect("writes the model's thinking level, the plan mode and the context meter", () =>
    Effect.gen(function* () {
      const { adapter, requests, events } = yield* antigravityProfileAdapter({
        env: { F5_ACP_USAGE_FRAMES: "1" },
      });
      const threadId = ThreadId.make("agy-session-control");
      yield* adapter.startSession({
        threadId,
        provider: "antigravity",
        cwd: process.cwd(),
        runtimeMode: "approval-required",
        modelSelection: antigravityModelSelection("gemini-4-neon", "low"),
      });
      const configWrites = (yield* requests()).filter(
        (request) => request.method === "session/set_config_option",
      );
      assert.deepEqual(
        configWrites.map((request) => [request.params?.configId, request.params?.value]),
        [
          ["model", "gemini-4-neon"],
          ["thought_level", "low"],
        ],
      );

      yield* adapter.sendTurn({
        threadId,
        input: "Plan the change",
        attachments: [],
        interactionMode: "plan",
      });
      const modeWrites = (yield* requests()).filter(
        (request) => request.method === "session/set_mode",
      );
      assert.deepEqual(
        modeWrites.map((request) => request.params?.modeId),
        ["plan"],
      );
      yield* adapter.sendTurn({ threadId, input: "Implement it", attachments: [] });
      assert.deepEqual(
        (yield* requests())
          .filter((request) => request.method === "session/set_mode")
          .map((request) => request.params?.modeId),
        ["plan", "default"],
      );

      const usage = events.filter((event) => event.type === "thread.token-usage.updated");
      assert.deepEqual(
        usage.map((event) =>
          event.type === "thread.token-usage.updated"
            ? [event.payload.contextTokens, event.payload.modelContextWindowTokens]
            : undefined,
        ),
        [
          [1200, 1_048_576],
          [2400, 1_048_576],
        ],
      );
      yield* adapter.stopSession(threadId);
    }).pipe(Effect.scoped),
  );

  it.effect("starts a fresh native session when the account revision changed", () =>
    Effect.gen(function* () {
      const { adapter, requests } = yield* antigravityProfileAdapter({ accountRevision: 2 });
      const threadId = ThreadId.make("agy-revision");
      const session = yield* adapter.startSession({
        threadId,
        provider: "antigravity",
        cwd: process.cwd(),
        runtimeMode: "approval-required",
        resumeCursor: { schemaVersion: 1, sessionId: "old-account-session", accountRevision: 1 },
      });
      const methods = (yield* requests()).map((request) => request.method);
      assert.include(methods, "session/new");
      assert.notInclude(methods, "session/load");
      assert.notInclude(methods, "session/resume");
      assert.deepInclude(session.resumeCursor as Record<string, unknown>, { accountRevision: 2 });
      yield* adapter.stopSession(threadId);
    }).pipe(Effect.scoped),
  );

  it.effect("asks before a command under Auto-accept edits", () =>
    Effect.gen(function* () {
      const { adapter, events } = yield* antigravityProfileAdapter({
        env: { T3_ACP_EMIT_TOOL_CALLS: "1" },
      });
      const threadId = ThreadId.make("agy-auto-accept");
      yield* adapter.startSession({
        threadId,
        provider: "antigravity",
        cwd: process.cwd(),
        runtimeMode: "auto-accept-edits",
      });
      const turn = yield* adapter
        .sendTurn({ threadId, input: "Read the package", attachments: [] })
        .pipe(Effect.forkChild);
      yield* Effect.promise(() =>
        vi.waitFor(() => assert.ok(events.some((event) => event.type === "request.opened"))),
      );
      const opened = events.find((event) => event.type === "request.opened");
      assert.ok(opened?.requestId);
      yield* adapter.respondToRequest(
        threadId,
        ApprovalRequestId.make(opened.requestId),
        "decline",
      );
      yield* Fiber.join(turn);
      yield* adapter.stopSession(threadId);
    }).pipe(Effect.scoped),
  );

  it.effect("publishes the latest context sample sent before session/new returned", () =>
    Effect.gen(function* () {
      const { adapter, events } = yield* antigravityProfileAdapter({
        env: { F5_ACP_STARTUP_USAGE: "1" },
      });
      const threadId = ThreadId.make("agy-startup-usage");
      yield* adapter.startSession({
        threadId,
        provider: "antigravity",
        cwd: process.cwd(),
        runtimeMode: "approval-required",
      });
      // Hardened sessions drop frames for a session not yet adopted; the latest sample survives.
      yield* Effect.promise(() =>
        vi.waitFor(() =>
          assert.deepEqual(
            events.flatMap((event) =>
              event.type === "thread.token-usage.updated" ? [event.payload.contextTokens] : [],
            ),
            [500],
          ),
        ),
      );
      yield* adapter.stopSession(threadId);
    }).pipe(
      Effect.scoped,
      Effect.provide(
        ServerConfig.layerTest(
          process.cwd(),
          { prefix: "f5-agy-hardened-usage-" },
          { acpHardeningEnabled: true },
        ).pipe(Layer.provideMerge(NodeServices.layer)),
      ),
    ),
  );

  it.effect("restores the persisted model and level on session recovery", () =>
    Effect.gen(function* () {
      const { adapter, requests } = yield* antigravityProfileAdapter({});
      const threadId = ThreadId.make("agy-recovery");
      // ProviderService recovery passes `model` and `modelOptions`, not a selection; the mock's
      // account default is Carbon.
      yield* adapter.startSession({
        threadId,
        provider: "antigravity",
        cwd: process.cwd(),
        runtimeMode: "approval-required",
        model: "gemini-4-neon",
        modelOptions: { antigravity: { thinking: "low" } },
      });
      assert.deepEqual(
        (yield* requests())
          .filter((request) => request.method === "session/set_config_option")
          .map((request) => [request.params?.configId, request.params?.value]),
        [
          ["model", "gemini-4-neon"],
          ["thought_level", "low"],
        ],
      );
      yield* adapter.stopSession(threadId);
    }).pipe(Effect.scoped),
  );

  it.effect("runs Plan commands under Full access once, without asking or a persistent grant", () =>
    Effect.gen(function* () {
      const { adapter, events, requests } = yield* antigravityProfileAdapter({
        env: { T3_ACP_EMIT_TOOL_CALLS: "1" },
      });
      const threadId = ThreadId.make("agy-plan-grant");
      yield* adapter.startSession({
        threadId,
        provider: "antigravity",
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({
        threadId,
        input: "Plan it",
        attachments: [],
        interactionMode: "plan",
      });
      assert.notOk(events.some((event) => event.type === "request.opened"));
      const selected = (yield* requests()).flatMap((frame) => {
        const result = (frame as { result?: { outcome?: { optionId?: string } } }).result;
        return result?.outcome?.optionId ? [result.outcome.optionId] : [];
      });
      assert.include(selected, "allow-once");
      assert.notInclude(selected, "allow-always");
      yield* adapter.stopSession(threadId);
    }).pipe(Effect.scoped),
  );

  it.effect("appends a command's output to its transcript before the command completes", () =>
    Effect.gen(function* () {
      const { adapter, events } = yield* antigravityProfileAdapter({
        env: { T3_ACP_EMIT_TOOL_CALLS: "1" },
      });
      const threadId = ThreadId.make("agy-command-output");
      yield* adapter.startSession({
        threadId,
        provider: "antigravity",
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({ threadId, input: "Read it", attachments: [] });
      const forTool = events.filter(
        (event) =>
          event.itemId === "tool-call-1" &&
          (event.type === "content.delta" || event.type === "item.completed"),
      );
      const outputs = forTool.flatMap((event) =>
        event.type === "content.delta" && event.payload.streamKind === "command_output"
          ? [event.payload.delta]
          : [],
      );
      assert.deepEqual(outputs, ['{ "name": "t3" }']);
      assert.equal(forTool.at(-1)?.type, "item.completed");
      yield* adapter.stopSession(threadId);
    }).pipe(Effect.scoped),
  );

  it.effect("reports the delivery accepted on the agent's first progress, mid-turn", () =>
    Effect.gen(function* () {
      const { adapter } = yield* antigravityProfileAdapter({
        env: { T3_ACP_EMIT_TOOL_CALLS: "1", T3_ACP_WAIT_AFTER_PERMISSION: "1" },
      });
      const threadId = ThreadId.make("agy-early-acceptance");
      yield* adapter.startSession({
        threadId,
        provider: "antigravity",
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });
      const accepted: Array<string> = [];
      const turn = yield* adapter.sendTurn({ threadId, input: "Read it", attachments: [] }).pipe(
        Effect.provideService(TurnAcceptanceSignal, {
          accept: (receipt) => Effect.sync(() => accepted.push(String(receipt.turnId))),
        }),
        Effect.forkChild,
      );
      // The agent asked to run a command and now waits; the prompt has not returned.
      yield* Effect.promise(() =>
        vi.waitFor(() => {
          if (accepted.length === 0) throw new Error("not accepted yet");
        }),
      );
      assert.isUndefined(turn.pollUnsafe());
      yield* adapter.interruptTurn(threadId);
      const result = yield* Fiber.join(turn);
      assert.deepEqual(accepted, [String(result.turnId)]);
      // Stopping an Antigravity turn may end its session already.
      yield* adapter.stopSession(threadId).pipe(Effect.ignore);
    }).pipe(Effect.scoped),
  );

  it.effect("refuses a workflow prompt steered into an ordinary session's running turn", () =>
    Effect.gen(function* () {
      const gateDir = yield* Effect.acquireRelease(
        Effect.promise(() => mkdtemp(path.join(os.tmpdir(), "agy-workflow-steer-"))),
        (directory) => Effect.promise(() => rm(directory, { recursive: true, force: true })),
      );
      const gate = path.join(gateDir, "go");
      const { adapter } = yield* antigravityProfileAdapter({
        env: { T3_ACP_PROMPT_GATE_PATH: gate },
      });
      const threadId = ThreadId.make("agy-workflow-steer");
      yield* adapter.startSession({
        threadId,
        provider: "antigravity",
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });
      const turn = yield* adapter
        .sendTurn({ threadId, input: "Start", attachments: [] })
        .pipe(Effect.forkChild);
      let activeTurnId: TurnId | undefined;
      yield* Effect.promise(() =>
        vi.waitFor(async () => {
          const sessions = await Effect.runPromise(adapter.listSessions());
          activeTurnId = sessions.find((session) => session.threadId === threadId)?.activeTurnId;
          if (!activeTurnId) throw new Error("no running turn yet");
        }),
      );
      const refused = yield* Effect.flip(
        adapter.sendTurn({
          threadId,
          input: "Review this",
          attachments: [],
          expectedTurnId: activeTurnId,
          workflowExecutionProfile: "unattended-readonly",
        }),
      );
      assert.include(
        String(refused.message),
        "This Antigravity session was not started for read-only workflow turns.",
      );
      yield* Effect.promise(() => writeFile(gate, ""));
      yield* Fiber.join(turn);
      yield* adapter.stopSession(threadId).pipe(Effect.ignore);
    }).pipe(Effect.scoped),
  );
  it.effect("refuses a steer whose workflow profile differs from the running turn's", () =>
    Effect.gen(function* () {
      const gateDir = yield* Effect.acquireRelease(
        Effect.promise(() => mkdtemp(path.join(os.tmpdir(), "agy-profile-steer-"))),
        (directory) => Effect.promise(() => rm(directory, { recursive: true, force: true })),
      );
      const gate = path.join(gateDir, "go");
      const wrapperPath = writeAcpWrapper(path.join(gateDir, "agent"), mockAgentPath, {
        env: { F5_ACP_ANTIGRAVITY_PROFILE: "1", T3_ACP_PROMPT_GATE_PATH: gate },
      });
      const adapter = yield* makeGrokAdapter(
        Schema.decodeSync(GrokSettings)({ binaryPath: wrapperPath }),
        {
          provider: "antigravity",
          instanceId: ProviderInstanceId.make("antigravity"),
          antigravity: { readOnlyWorkflowCertified: () => true },
        },
      );
      const threadId = ThreadId.make("agy-profile-steer");
      yield* adapter.startSession({
        threadId,
        provider: "antigravity",
        cwd: process.cwd(),
        runtimeMode: "full-access",
        workflowExecutionProfile: "attended-readonly",
      });
      const turn = yield* adapter
        .sendTurn({
          threadId,
          input: "Start",
          attachments: [],
          workflowExecutionProfile: "attended-readonly",
        })
        .pipe(Effect.forkChild);
      let activeTurnId: TurnId | undefined;
      yield* Effect.promise(() =>
        vi.waitFor(async () => {
          const sessions = await Effect.runPromise(adapter.listSessions());
          activeTurnId = sessions.find((session) => session.threadId === threadId)?.activeTurnId;
          if (!activeTurnId) throw new Error("no running turn yet");
        }),
      );
      const refused = yield* Effect.flip(
        adapter.sendTurn({
          threadId,
          input: "Review this",
          attachments: [],
          expectedTurnId: activeTurnId,
          workflowExecutionProfile: "unattended-readonly",
        }),
      );
      assert.include(
        String(refused.message),
        "needs a different workflow profile than the running Antigravity turn",
      );
      yield* Effect.promise(() => writeFile(gate, ""));
      yield* Fiber.join(turn);
      yield* adapter.stopSession(threadId).pipe(Effect.ignore);
    }).pipe(Effect.scoped),
  );
  it.effect(
    "keeps the turn's acceptance when a steer arrives before the agent's first progress",
    () =>
      Effect.gen(function* () {
        const gateDir = yield* Effect.acquireRelease(
          Effect.promise(() => mkdtemp(path.join(os.tmpdir(), "agy-steer-gate-"))),
          (directory) => Effect.promise(() => rm(directory, { recursive: true, force: true })),
        );
        const gate = path.join(gateDir, "go");
        const { adapter } = yield* antigravityProfileAdapter({
          env: { T3_ACP_PROMPT_GATE_PATH: gate },
        });
        const threadId = ThreadId.make("agy-steer-before-progress");
        yield* adapter.startSession({
          threadId,
          provider: "antigravity",
          cwd: process.cwd(),
          runtimeMode: "full-access",
        });
        const accepted: Array<string> = [];
        const turn = yield* adapter.sendTurn({ threadId, input: "Start", attachments: [] }).pipe(
          Effect.provideService(TurnAcceptanceSignal, {
            accept: (receipt) => Effect.sync(() => accepted.push(String(receipt.turnId))),
          }),
          Effect.forkChild,
        );
        let activeTurnId: TurnId | undefined;
        yield* Effect.promise(() =>
          vi.waitFor(async () => {
            const sessions = await Effect.runPromise(adapter.listSessions());
            activeTurnId = sessions.find((session) => session.threadId === threadId)?.activeTurnId;
            if (!activeTurnId) throw new Error("no running turn yet");
          }),
        );
        // The steer runs with a signal too; a steer never reports acceptance itself.
        const steer = yield* adapter
          .sendTurn({ threadId, input: "Also this", attachments: [], expectedTurnId: activeTurnId })
          .pipe(
            Effect.provideService(TurnAcceptanceSignal, {
              accept: () => Effect.sync(() => accepted.push("steer")),
            }),
            Effect.forkChild,
          );
        yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 50)));
        yield* Effect.promise(() => writeFile(gate, ""));
        yield* Effect.promise(() =>
          vi.waitFor(() => {
            if (accepted.length === 0) throw new Error("not accepted yet");
          }),
        );
        const result = yield* Fiber.join(turn);
        yield* Fiber.join(steer).pipe(Effect.ignore);
        assert.deepEqual(accepted, [String(result.turnId)]);
        yield* adapter.stopSession(threadId).pipe(Effect.ignore);
      }).pipe(Effect.scoped),
  );

  it.effect("does not report acceptance when the prompt fails before any progress", () =>
    Effect.gen(function* () {
      const { adapter } = yield* antigravityProfileAdapter({
        env: { T3_ACP_FAIL_PROMPT_TRANSPORT: "exit" },
      });
      const threadId = ThreadId.make("agy-no-acceptance");
      yield* adapter.startSession({
        threadId,
        provider: "antigravity",
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });
      const accepted: Array<string> = [];
      const exit = yield* adapter.sendTurn({ threadId, input: "Hi", attachments: [] }).pipe(
        Effect.provideService(TurnAcceptanceSignal, {
          accept: (receipt) => Effect.sync(() => accepted.push(String(receipt.turnId))),
        }),
        Effect.exit,
      );
      assert.equal(exit._tag, "Failure");
      assert.deepEqual(accepted, []);
    }).pipe(Effect.scoped),
  );

  for (const kind of ["other", "null"])
    it.effect(`asks in Plan under Full access when the tool kind is ${kind}`, () =>
      Effect.gen(function* () {
        const { adapter, events, requests } = yield* antigravityProfileAdapter({
          env: { T3_ACP_EMIT_TOOL_CALLS: "1", T3_ACP_PERMISSION_KIND: kind },
        });
        const threadId = ThreadId.make(`agy-plan-kind-${kind}`);
        yield* adapter.startSession({
          threadId,
          provider: "antigravity",
          cwd: process.cwd(),
          runtimeMode: "full-access",
        });
        const turn = yield* adapter
          .sendTurn({ threadId, input: "Plan it", attachments: [], interactionMode: "plan" })
          .pipe(Effect.forkChild);
        yield* Effect.promise(() =>
          vi.waitFor(() => assert.ok(events.some((event) => event.type === "request.opened"))),
        );
        const opened = events.find((event) => event.type === "request.opened");
        assert.ok(opened?.type === "request.opened" && opened.requestId);
        assert.notInclude(
          (opened.payload.approvalOptions ?? []).map((option) => option.decision),
          "acceptForSession",
        );
        // Even a thread-wide answer is delivered to the CLI as single-use.
        yield* adapter.respondToRequest(
          threadId,
          ApprovalRequestId.make(opened.requestId),
          "acceptForSession",
        );
        yield* Fiber.join(turn);
        const selected = (yield* requests()).flatMap((frame) => {
          const result = (frame as { result?: { outcome?: { optionId?: string } } }).result;
          return result?.outcome?.optionId ? [result.outcome.optionId] : [];
        });
        assert.include(selected, "allow-once");
        assert.notInclude(selected, "allow-always");
        yield* adapter.stopSession(threadId);
      }).pipe(Effect.scoped),
    );

  it.effect("honors a thread grant from a Default turn for the same command in Plan", () =>
    Effect.gen(function* () {
      const { adapter, events } = yield* antigravityProfileAdapter({
        env: { T3_ACP_EMIT_TOOL_CALLS: "1" },
      });
      const threadId = ThreadId.make("agy-plan-grant-carryover");
      yield* adapter.startSession({
        threadId,
        provider: "antigravity",
        cwd: process.cwd(),
        runtimeMode: "approval-required",
      });
      const first = yield* adapter
        .sendTurn({ threadId, input: "Do it", attachments: [] })
        .pipe(Effect.forkChild);
      yield* Effect.promise(() =>
        vi.waitFor(() => assert.ok(events.some((event) => event.type === "request.opened"))),
      );
      const opened = events.find((event) => event.type === "request.opened");
      assert.ok(opened?.type === "request.opened" && opened.requestId);
      yield* adapter.respondToRequest(
        threadId,
        ApprovalRequestId.make(opened.requestId),
        "acceptForSession",
      );
      yield* Fiber.join(first);

      yield* adapter.sendTurn({
        threadId,
        input: "Plan it",
        attachments: [],
        interactionMode: "plan",
      });
      assert.equal(events.filter((event) => event.type === "request.opened").length, 1);
      yield* adapter.stopSession(threadId);
    }).pipe(Effect.scoped),
  );

  it.effect("shows Antigravity's CommandLine on the approval card, not the tool name", () =>
    Effect.gen(function* () {
      const { adapter, events } = yield* antigravityProfileAdapter({
        env: { T3_ACP_EMIT_TOOL_CALLS: "1", T3_ACP_PERMISSION_ANTIGRAVITY_SHAPE: "1" },
      });
      const threadId = ThreadId.make("agy-command-line-detail");
      yield* adapter.startSession({
        threadId,
        provider: "antigravity",
        cwd: process.cwd(),
        runtimeMode: "approval-required",
      });
      const turn = yield* adapter
        .sendTurn({ threadId, input: "Do it", attachments: [] })
        .pipe(Effect.forkChild);
      yield* Effect.promise(() =>
        vi.waitFor(() => assert.ok(events.some((event) => event.type === "request.opened"))),
      );
      const opened = events.find((event) => event.type === "request.opened");
      assert.ok(opened?.type === "request.opened" && opened.requestId);
      assert.equal(opened.payload.detail, "cat server/package.json");
      yield* adapter.respondToRequest(threadId, ApprovalRequestId.make(opened.requestId), "accept");
      yield* Fiber.join(turn);
      yield* adapter.stopSession(threadId);
    }).pipe(Effect.scoped),
  );

  it.effect("asks for Plan commands under Supervised and offers a thread grant", () =>
    Effect.gen(function* () {
      const { adapter, events } = yield* antigravityProfileAdapter({
        env: { T3_ACP_EMIT_TOOL_CALLS: "1" },
      });
      const threadId = ThreadId.make("agy-plan-supervised");
      yield* adapter.startSession({
        threadId,
        provider: "antigravity",
        cwd: process.cwd(),
        runtimeMode: "approval-required",
      });
      const turn = yield* adapter
        .sendTurn({ threadId, input: "Plan it", attachments: [], interactionMode: "plan" })
        .pipe(Effect.forkChild);
      yield* Effect.promise(() =>
        vi.waitFor(() => assert.ok(events.some((event) => event.type === "request.opened"))),
      );
      const opened = events.find((event) => event.type === "request.opened");
      assert.ok(opened?.type === "request.opened" && opened.requestId);
      assert.include(
        (opened.payload.approvalOptions ?? []).map((option) => option.decision),
        "acceptForSession",
      );
      yield* adapter.respondToRequest(threadId, ApprovalRequestId.make(opened.requestId), "accept");
      yield* Fiber.join(turn);
      yield* adapter.stopSession(threadId);
    }).pipe(Effect.scoped),
  );

  it.effect("scrubs the configured Gemini key from client events", () =>
    Effect.gen(function* () {
      const key = "AIzaSyEchoedFixtureKey00000000";
      const { adapter, events } = yield* antigravityProfileAdapter({
        env: { F5_ACP_ECHO_TEXT: key },
        credentials: [key],
      });
      const threadId = ThreadId.make("agy-key-scrub");
      yield* adapter.startSession({
        threadId,
        provider: "antigravity",
        cwd: process.cwd(),
        runtimeMode: "approval-required",
      });
      yield* adapter.sendTurn({ threadId, input: "Show the env", attachments: [] });
      const published = JSON.stringify(events);
      assert.notInclude(published, key);
      assert.include(published, "[redacted]");
      yield* adapter.stopSession(threadId);
    }).pipe(Effect.scoped),
  );

  it.effect("scrubs a key containing characters JSON escapes", () =>
    Effect.gen(function* () {
      const key = 'AIza"quoted\\fixture-key-0000';
      const { adapter, events } = yield* antigravityProfileAdapter({
        env: { F5_ACP_ECHO_TEXT: key },
        credentials: [key],
      });
      const threadId = ThreadId.make("agy-key-scrub-escaped");
      yield* adapter.startSession({
        threadId,
        provider: "antigravity",
        cwd: process.cwd(),
        runtimeMode: "approval-required",
      });
      yield* adapter.sendTurn({ threadId, input: "Show the env", attachments: [] });
      const strings: string[] = [];
      const collect = (value: unknown): void => {
        if (typeof value === "string") strings.push(value);
        else if (value && typeof value === "object") Object.values(value).forEach(collect);
      };
      collect(events);
      assert.isFalse(strings.some((value) => value.includes(key)));
      assert.isTrue(strings.some((value) => value.includes("[redacted]")));
      yield* adapter.stopSession(threadId);
    }).pipe(Effect.scoped),
  );

  it.effect("refuses new work once newer sign-in settings were published", () =>
    Effect.gen(function* () {
      let stale: string | undefined;
      const { adapter } = yield* antigravityProfileAdapter({ staleAccount: () => stale });
      const threadId = ThreadId.make("agy-stale");
      yield* adapter.startSession({
        threadId,
        provider: "antigravity",
        cwd: process.cwd(),
        runtimeMode: "approval-required",
      });
      stale = "Antigravity sign-in settings just changed. Retry in a moment.";
      const turn = yield* adapter
        .sendTurn({ threadId, input: "Hello", attachments: [] })
        .pipe(Effect.result);
      assert.equal(turn._tag, "Failure");
      const start = yield* adapter
        .startSession({
          threadId: ThreadId.make("agy-stale-2"),
          provider: "antigravity",
          cwd: process.cwd(),
          runtimeMode: "approval-required",
        })
        .pipe(Effect.result);
      assert.equal(start._tag, "Failure");
      yield* adapter.stopSession(threadId);
    }).pipe(Effect.scoped),
  );
});

const GrokAdapterExitingAgentTestLayer = Layer.effect(
  GrokAdapter,
  Effect.gen(function* () {
    const dir = yield* Effect.promise(() => mkdtemp(path.join(os.tmpdir(), "grok-acp-exit-")));
    const wrapperPath = writeAcpWrapper(path.join(dir, "fake-grok"), mockAgentPath, {
      env: { T3_ACP_EXIT_DURING_PROMPT: "1" },
    });
    const settings = Schema.decodeSync(GrokSettings)({ binaryPath: wrapperPath });
    return yield* makeGrokAdapter(settings);
  }),
).pipe(
  Layer.provideMerge(
    ServerConfig.layerTest(process.cwd(), { prefix: "t3code-grok-adapter-exit-test-" }),
  ),
  Layer.provideMerge(NodeServices.layer),
);

it.layer(GrokAdapterExitingAgentTestLayer)("GrokAdapterLive agent exit", (it) => {
  it.effect("fails the active turn and releases the session when the agent exits", () =>
    Effect.gen(function* () {
      const adapter = yield* GrokAdapter;
      const threadId = ThreadId.make("grok-exit-during-prompt");
      const events: ProviderRuntimeEvent[] = [];
      const eventFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.sync(() => {
          events.push(event);
        }),
      ).pipe(Effect.forkChild);
      yield* adapter.startSession({
        threadId,
        provider: "grok",
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });

      yield* adapter
        .sendTurn({ threadId, input: "exit mid-prompt", attachments: [] })
        .pipe(Effect.exit);
      const turnId = events.find((event) => event.type === "turn.started")?.turnId;
      assert.isDefined(turnId);
      const exited = (event: ProviderRuntimeEvent) =>
        event.type === "session.exited" && event.threadId === threadId;
      for (let attempt = 0; attempt < 200 && !events.some(exited); attempt += 1)
        yield* Effect.promise(() => new Promise<void>((resolve) => setTimeout(resolve, 10)));

      const completions = events.filter(
        (event) => event.type === "turn.completed" && event.turnId === turnId,
      );
      assert.equal(completions.length, 1);
      assert.deepInclude(completions[0]!.payload, { state: "failed" });
      assert.deepInclude(events.find(exited)?.payload, { exitKind: "error", recoverable: true });
      assert.isFalse(yield* adapter.hasSession(threadId));
      yield* Fiber.interrupt(eventFiber);
    }),
  );
});

const grokApprovalTestLayer = (env: Record<string, string>) =>
  Layer.effect(
    GrokAdapter,
    Effect.gen(function* () {
      const dir = yield* Effect.promise(() =>
        mkdtemp(path.join(os.tmpdir(), "grok-acp-approval-")),
      );
      const wrapperPath = writeAcpWrapper(path.join(dir, "fake-grok"), mockAgentPath, {
        env: {
          T3_ACP_EMIT_TOOL_CALLS: "1",
          T3_ACP_OMIT_ALLOW_ALWAYS: "1",
          T3_ACP_PERMISSION_REQUEST_COUNT: "2",
          ...env,
        },
      });
      const settings = Schema.decodeSync(GrokSettings)({ binaryPath: wrapperPath });
      return yield* makeGrokAdapter(settings);
    }),
  ).pipe(
    Layer.provideMerge(
      ServerConfig.layerTest(process.cwd(), { prefix: "t3code-grok-adapter-approval-test-" }),
    ),
    Layer.provideMerge(NodeServices.layer),
  );

/** Runs one supervised turn, answering every approval prompt with "Always allow this session". */
const runAlwaysAllowTurn = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const adapter = yield* GrokAdapter;
    const events: ProviderRuntimeEvent[] = [];
    const answered = new Set<string>();
    const eventFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
      Effect.gen(function* () {
        events.push(event);
        if (event.type === "request.opened" && event.requestId && !answered.has(event.requestId)) {
          answered.add(event.requestId);
          yield* adapter.respondToRequest(
            threadId,
            ApprovalRequestId.make(event.requestId),
            "acceptForSession",
          );
        }
      }),
    ).pipe(Effect.forkChild);
    yield* adapter.startSession({
      threadId,
      provider: "grok",
      cwd: process.cwd(),
      runtimeMode: "approval-required",
    });
    yield* adapter.sendTurn({ threadId, input: "Read the package", attachments: [] });
    const completed = (event: ProviderRuntimeEvent) => event.type === "turn.completed";
    for (let attempt = 0; attempt < 200 && !events.some(completed); attempt += 1)
      yield* Effect.promise(() => new Promise<void>((resolve) => setTimeout(resolve, 10)));
    yield* adapter.stopSession(threadId);
    yield* Fiber.interrupt(eventFiber);
    return {
      prompts: events.filter((event) => event.type === "request.opened").length,
      completion: events.find(completed),
    };
  });

it.layer(grokApprovalTestLayer({}))("GrokAdapterLive always allow", (it) => {
  it.effect("keeps the turn running and stops asking when Grok has no allow_always", () =>
    Effect.gen(function* () {
      const { prompts, completion } = yield* runAlwaysAllowTurn(
        ThreadId.make("grok-always-allow-once"),
      );
      assert.deepInclude(completion?.payload, { state: "completed" });
      assert.equal(prompts, 1);
    }),
  );
});

it.layer(grokApprovalTestLayer({ T3_ACP_SECOND_PERMISSION_COMMAND: "rm -rf build" }))(
  "GrokAdapterLive always allow scope",
  (it) => {
    it.effect("asks again before a different command", () =>
      Effect.gen(function* () {
        const { prompts, completion } = yield* runAlwaysAllowTurn(
          ThreadId.make("grok-always-allow-scope"),
        );
        assert.deepInclude(completion?.payload, { state: "completed" });
        assert.equal(prompts, 2);
      }),
    );
  },
);

/** Records the interaction session F5 hands its MCP catalog, so a test can call the tool. */
const fakeInteractionPreview = () => {
  const sessions: InteractionSession[] = [];
  const preview: PreviewMcpHttpServerShape = {
    getUrl: () => "http://127.0.0.1:1/mcp/preview",
    createSessionConfig: (input) => {
      if (input.interaction) sessions.push(input.interaction);
      return {
        serverName: input.serverName ?? "f5_test",
        serverDefinition: {
          type: "http",
          url: `http://127.0.0.1:1/mcp/${input.catalog ?? "preview"}`,
          enabled: true,
          bearerTokenEnvVar: "F5_TEST_TOKEN",
        },
        env: { F5_TEST_TOKEN: "interaction-token-secret" },
        dispose: () => {},
      };
    },
  };
  return { preview, sessions };
};

const STDIO_LAUNCH = { command: "/opt/f5/f5", args: ["entry.mjs", "mcp-session-stdio"], env: {} };

const QUESTIONS = [
  {
    question: "Which database?",
    header: "Database",
    options: [
      { label: "Postgres", description: "Relational" },
      { label: "SQLite", description: "Embedded" },
    ],
    multiSelect: false,
  },
];

rootIt.layer(
  ServerConfig.layerTest(process.cwd(), { prefix: "f5-agy-plan-test-" }).pipe(
    Layer.provideMerge(NodeServices.layer),
  ),
)("Antigravity Plan mode", (it) => {
  const planAdapter = (env: Record<string, string> = {}) =>
    antigravityProfileAdapter({
      env: (dir) => ({
        F5_ACP_ANTIGRAVITY_PLAN_ARTIFACT_ROOT: path.join(
          dir,
          "profile",
          "antigravity-acp",
          "brain",
        ),
        ...env,
      }),
      options: (dir) => ({ antigravityProfileDirectory: path.join(dir, "profile") }),
    });
  const proposed = (events: ReadonlyArray<ProviderRuntimeEvent>) =>
    events.filter((event) => event.type === "turn.proposed.completed");

  it.effect("shows a Plan turn's feedback artifact, in full, as the proposed plan", () =>
    Effect.gen(function* () {
      const { adapter, events } = yield* planAdapter();
      const threadId = ThreadId.make("agy-plan-card");
      yield* adapter.startSession({
        threadId,
        provider: "antigravity",
        cwd: process.cwd(),
        runtimeMode: "approval-required",
      });
      yield* adapter.sendTurn({
        threadId,
        input: "Plan it",
        attachments: [],
        interactionMode: "plan",
      });
      const plans = proposed(events);
      assert.equal(plans.length, 1);
      const plan = plans[0]!;
      const markdown = plan.type === "turn.proposed.completed" ? plan.payload.planMarkdown : "";
      // Longer than the 8,000 characters tool payloads are trimmed to.
      assert.isAbove(markdown.length, 8_000);
      assert.match(markdown, /^# Plan/);
      assert.match(markdown, /End of plan\.\n$/);
      const completedIndex = events.findIndex((event) => event.type === "turn.completed");
      assert.isBelow(events.indexOf(plan), completedIndex);

      const artifactItems = events.filter(
        (event) => event.type === "item.completed" && event.itemId === "plan-artifact-1",
      );
      assert.isAbove(artifactItems.length, 0);
      for (const item of artifactItems)
        if (item.type === "item.completed") {
          assert.equal(item.payload.itemType, "dynamic_tool_call");
          assert.equal(item.payload.title, "Updated plan artifact implementation_plan.md");
          assert.notProperty(item.payload.data ?? {}, "changes");
        }

      // A default-mode turn that writes the same artifact proposes nothing.
      yield* adapter.sendTurn({ threadId, input: "Implement it", attachments: [] });
      assert.equal(proposed(events).length, 1);
      yield* adapter.stopSession(threadId);
    }).pipe(Effect.scoped),
  );

  it.effect("reads Python-style artifact metadata", () =>
    Effect.gen(function* () {
      const { adapter, events } = yield* planAdapter({
        F5_ACP_ANTIGRAVITY_PLAN_METADATA_STRING: "1",
      });
      const threadId = ThreadId.make("agy-plan-python-metadata");
      yield* adapter.startSession({
        threadId,
        provider: "antigravity",
        cwd: process.cwd(),
        runtimeMode: "approval-required",
      });
      yield* adapter.sendTurn({
        threadId,
        input: "Plan it",
        attachments: [],
        interactionMode: "plan",
      });
      assert.equal(proposed(events).length, 1);
      yield* adapter.stopSession(threadId);
    }).pipe(Effect.scoped),
  );

  it.effect("proposes nothing for an artifact that does not request feedback", () =>
    Effect.gen(function* () {
      const { adapter, events } = yield* planAdapter({ F5_ACP_ANTIGRAVITY_PLAN_FEEDBACK: "0" });
      const threadId = ThreadId.make("agy-plan-no-feedback");
      yield* adapter.startSession({
        threadId,
        provider: "antigravity",
        cwd: process.cwd(),
        runtimeMode: "approval-required",
      });
      yield* adapter.sendTurn({
        threadId,
        input: "Plan it",
        attachments: [],
        interactionMode: "plan",
      });
      assert.equal(proposed(events).length, 0);
      const titles = events.flatMap((event) =>
        event.type === "item.completed" && event.itemId === "plan-artifact-1"
          ? [event.payload.title]
          : [],
      );
      assert.include(titles, "Updated artifact implementation_plan.md");
      yield* adapter.stopSession(threadId);
    }).pipe(Effect.scoped),
  );

  it.effect("treats an edit outside the brain directory as a file change", () =>
    Effect.gen(function* () {
      const { adapter, events } = yield* antigravityProfileAdapter({
        env: (dir) => ({ F5_ACP_ANTIGRAVITY_PLAN_ARTIFACT_ROOT: path.join(dir, "workspace") }),
        options: (dir) => ({ antigravityProfileDirectory: path.join(dir, "profile") }),
      });
      const threadId = ThreadId.make("agy-plan-outside");
      yield* adapter.startSession({
        threadId,
        provider: "antigravity",
        cwd: process.cwd(),
        runtimeMode: "approval-required",
      });
      yield* adapter.sendTurn({
        threadId,
        input: "Plan it",
        attachments: [],
        interactionMode: "plan",
      });
      assert.equal(proposed(events).length, 0);
      const item = events.find(
        (event) => event.type === "item.completed" && event.itemId === "plan-artifact-1",
      );
      assert.equal(
        item?.type === "item.completed" ? item.payload.itemType : undefined,
        "file_change",
      );
      yield* adapter.stopSession(threadId);
    }).pipe(Effect.scoped),
  );
});

rootIt.layer(
  ServerConfig.layerTest(process.cwd(), { prefix: "f5-agy-interaction-test-" }).pipe(
    Layer.provideMerge(NodeServices.layer),
  ),
)("Antigravity questions through F5's MCP tool", (it) => {
  const interactionAdapter = (env: Record<string, string> = {}) =>
    Effect.gen(function* () {
      const fake = fakeInteractionPreview();
      const harness = yield* antigravityProfileAdapter({
        env,
        options: () => ({
          previewMcpHttpServer: fake.preview,
          mcpSessionStdioLaunch: STDIO_LAUNCH,
        }),
      });
      return { ...harness, sessions: fake.sessions };
    });

  it.effect(
    "offers the question tool over stdio and appends the guidance to the system prompt",
    () =>
      Effect.gen(function* () {
        const { adapter, requests } = yield* interactionAdapter({
          ACP_MOCK_SYSTEM_PROMPT_APPEND: "1",
        });
        const threadId = ThreadId.make("agy-interaction-catalog");
        yield* adapter.startSession({
          threadId,
          provider: "antigravity",
          cwd: process.cwd(),
          runtimeMode: "approval-required",
        });
        const created = (yield* requests()).find((request) => request.method === "session/new");
        const servers = created?.params?.mcpServers as ReadonlyArray<Record<string, unknown>>;
        const interaction = servers.find((server) =>
          String(server.name).startsWith("f5_interaction_"),
        );
        assert.ok(interaction);
        assert.match(String(interaction.name), /^f5_interaction_[0-9a-f]{8}$/);
        assert.equal(interaction.command, "/opt/f5/f5");
        assert.deepEqual(interaction.args, ["entry.mjs", "mcp-session-stdio"]);
        assert.deepEqual(interaction.env, [
          { name: "F5_MCP_URL", value: "http://127.0.0.1:1/mcp/interaction" },
          { name: "F5_MCP_TOKEN", value: "interaction-token-secret" },
        ]);
        const meta = created?.params?._meta as
          | { antigravity?: { systemPrompt?: { append?: string } } }
          | undefined;
        assert.include(meta?.antigravity?.systemPrompt?.append ?? "", "ask_user_question");
        yield* adapter.stopSession(threadId);
      }).pipe(Effect.scoped),
  );

  it.effect("sends no system prompt guidance to an agent that does not advertise it", () =>
    Effect.gen(function* () {
      const { adapter, requests } = yield* interactionAdapter();
      const threadId = ThreadId.make("agy-interaction-no-append");
      yield* adapter.startSession({
        threadId,
        provider: "antigravity",
        cwd: process.cwd(),
        runtimeMode: "approval-required",
      });
      const created = (yield* requests()).find((request) => request.method === "session/new");
      assert.notProperty(created?.params ?? {}, "_meta");
      yield* adapter.stopSession(threadId);
    }).pipe(Effect.scoped),
  );

  it.effect("allows the question tool once, even in Plan mode under approval-required", () =>
    Effect.gen(function* () {
      const { adapter, events } = yield* interactionAdapter({
        F5_ACP_ANTIGRAVITY_INTERACTION_PERMISSION: "1",
      });
      const threadId = ThreadId.make("agy-interaction-permission");
      yield* adapter.startSession({
        threadId,
        provider: "antigravity",
        cwd: process.cwd(),
        runtimeMode: "approval-required",
      });
      yield* adapter.sendTurn({
        threadId,
        input: "Plan it",
        attachments: [],
        interactionMode: "plan",
      });
      assert.equal(
        events.some((event) => event.type === "request.opened"),
        false,
      );
      const text = events
        .flatMap((event) => (event.type === "content.delta" ? [event.payload.delta] : []))
        .join("");
      assert.include(text, "permission:allow");
      yield* adapter.stopSession(threadId);
    }).pipe(Effect.scoped),
  );

  /** An Antigravity session whose prompt runs until the test opens its gate. */
  const gatedInteraction = (threadName: string, env: Record<string, string> = {}) =>
    Effect.gen(function* () {
      const gateDir = yield* Effect.acquireRelease(
        Effect.promise(() => mkdtemp(path.join(os.tmpdir(), "agy-gate-"))),
        (dir) => Effect.promise(() => rm(dir, { recursive: true, force: true })),
      );
      const gate = path.join(gateDir, "open");
      const harness = yield* interactionAdapter({ T3_ACP_PROMPT_GATE_PATH: gate, ...env });
      const threadId = ThreadId.make(threadName);
      yield* harness.adapter.startSession({
        threadId,
        provider: "antigravity",
        cwd: process.cwd(),
        runtimeMode: "approval-required",
      });
      const session = harness.sessions[0]!;
      const turn = yield* harness.adapter
        .sendTurn({ threadId, input: "Ask me", attachments: [] })
        .pipe(Effect.exit, Effect.forkChild);
      yield* Effect.promise(() =>
        vi.waitFor(async () =>
          assert.ok(
            (await Effect.runPromise(harness.requests())).some(
              (request) => request.method === "session/prompt",
            ),
          ),
        ),
      );
      const ask = () =>
        Effect.gen(function* () {
          const opened = yield* Effect.promise(() => session.openQuestion(QUESTIONS));
          assert.ok("questionId" in opened);
          const outcome = session.questionOutcome(opened.questionId);
          assert.ok(outcome);
          const request = yield* Effect.promise(() =>
            vi.waitFor(() => {
              const found = harness.events.find(
                (event) =>
                  event.type === "user-input.requested" && event.requestId === opened.questionId,
              );
              assert.ok(found?.type === "user-input.requested");
              return found;
            }),
          );
          return { questionId: opened.questionId, outcome, request };
        });
      const openGate = Effect.promise(() => writeFile(gate, ""));
      return { ...harness, threadId, session, turn, ask, openGate };
    });

  it.effect("shows the questions as a card and returns the answers", () =>
    Effect.gen(function* () {
      const { adapter, events, threadId, turn, ask, openGate } =
        yield* gatedInteraction("agy-interaction-answer");
      const { questionId, outcome, request } = yield* ask();
      assert.deepEqual(request.payload.questions, [
        {
          id: "Which database?",
          header: "Database",
          question: "Which database?",
          multiSelect: false,
          options: [
            { label: "Postgres", description: "Relational" },
            { label: "SQLite", description: "Embedded" },
          ],
        },
      ]);
      assert.ok(request.turnId);
      yield* adapter.respondToUserInput(threadId, ApprovalRequestId.make(questionId), {
        "Which database?": "SQLite",
      });
      assert.deepEqual(yield* Effect.promise(() => outcome), {
        answers: { "Which database?": "SQLite" },
      });
      assert.equal(events.filter((event) => event.type === "user-input.resolved").length, 1);

      // Dismissing the card answers nothing.
      const dismissed = yield* ask();
      yield* adapter.respondToUserInput(threadId, ApprovalRequestId.make(dismissed.questionId), {});
      assert.deepEqual(yield* Effect.promise(() => dismissed.outcome), { cancelled: true });
      yield* openGate;
      yield* Fiber.join(turn);
      yield* adapter.stopSession(threadId);
    }).pipe(Effect.scoped),
  );

  it.effect("closes the card before the turn that asked completes", () =>
    Effect.gen(function* () {
      const { adapter, events, threadId, session, turn, ask, openGate } = yield* gatedInteraction(
        "agy-interaction-turn-end",
      );
      const { questionId, outcome, request } = yield* ask();
      yield* openGate;
      const exit = yield* Fiber.join(turn);
      assert.equal(exit._tag, "Success");
      assert.deepEqual(yield* Effect.promise(() => outcome), { cancelled: true });
      const resolvedAt = events.findIndex(
        (event) => event.type === "user-input.resolved" && event.requestId === questionId,
      );
      const completedAt = events.findIndex((event) => event.type === "turn.completed");
      assert.ok(resolvedAt >= 0 && resolvedAt < completedAt);
      const warning = events.find((event) => event.type === "runtime.warning");
      assert.ok(warning?.type === "runtime.warning");
      assert.include(warning.payload.message, "finished its turn");
      assert.equal(warning.turnId, request.turnId);
      // Between turns, nobody waits for an answer: no card opens.
      assert.deepEqual(yield* Effect.promise(() => session.openQuestion(QUESTIONS)), {
        cancelled: true,
      });
      yield* adapter.stopSession(threadId);
      assert.deepEqual(yield* Effect.promise(() => session.openQuestion(QUESTIONS)), {
        cancelled: true,
      });
      assert.equal(events.filter((event) => event.type === "user-input.requested").length, 1);
    }).pipe(Effect.scoped),
  );

  it.effect("closes the card when the prompt that asked fails", () =>
    Effect.gen(function* () {
      const { adapter, events, threadId, turn, ask, openGate } = yield* gatedInteraction(
        "agy-interaction-prompt-failure",
        { T3_ACP_FAIL_PROMPT_AFTER_GATE: "1" },
      );
      const { questionId, outcome } = yield* ask();
      yield* openGate;
      const exit = yield* Fiber.join(turn);
      assert.equal(exit._tag, "Failure");
      assert.deepEqual(yield* Effect.promise(() => outcome), { cancelled: true });
      assert.ok(
        events.some(
          (event) => event.type === "user-input.resolved" && event.requestId === questionId,
        ),
      );
      yield* adapter.stopSession(threadId);
    }).pipe(Effect.scoped),
  );
});
