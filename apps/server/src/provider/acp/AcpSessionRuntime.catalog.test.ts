import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Cause, Effect, Fiber, Layer } from "effect";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it, vi } from "vitest";
import { AcpSessionRuntime } from "./AcpSessionRuntime";
import { writeAcpWrapper } from "../../testUtils/cli";

describe("ACP catalog startup wire payloads", () => {
  it("redacts whole API keys in process-exit stderr and request failure traces", async () => {
    const failures: unknown[] = [];
    const secret = "sk-ant-api03-AbCdEf_GhIjKlMnOpQr-StUvWx_yz0123456789-AA";
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const context = yield* Layer.build(
          AcpSessionRuntime.layer({
            spawn: {
              command: process.execPath,
              args: [
                "-e",
                'process.stdin.once("data", () => { process.stderr.write(process.env.F5_TEST_DIAGNOSTIC); process.exit(7); });',
              ],
              env: { F5_TEST_DIAGNOSTIC: secret },
            },
            cwd: process.cwd(),
            clientInfo: { name: "test", version: "1" },
            requestLogger: (event) =>
              Effect.sync(() => {
                if (event.failure) failures.push(event.failure);
              }),
          }),
        );
        const runtime = yield* Effect.service(AcpSessionRuntime).pipe(Effect.provide(context));
        return yield* runtime.start().pipe(Effect.result);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    );
    expect(result._tag).toBe("Failure");
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(secret);
    expect(serialized).toContain("[redacted]");
    expect(JSON.stringify(failures)).not.toContain(secret);
    expect(JSON.stringify(failures)).toContain("[redacted]");
  });
  it.each(["new", "load", "load-fallback", "resume", "resume-fallback"] as const)(
    "sends validated MCP configuration on %s",
    async (branch) => {
      const cwd = await mkdtemp(path.join(tmpdir(), "f5-acp-catalog-"));
      const log = path.join(cwd, "requests.jsonl");
      const executable = writeAcpWrapper(
        path.join(cwd, "agent"),
        path.resolve("scripts/acp-mock-agent.ts"),
        {
          env: {
            ACP_MOCK_MCP_HTTP: "1",
            T3_ACP_REQUEST_LOG_PATH: log,
            ...(branch === "load-fallback" ? { T3_ACP_LOAD_FAIL_NOT_FOUND: "1" } : {}),
            ...(branch === "resume-fallback" ? { T3_ACP_RESUME_FAIL: "missing" } : {}),
          },
        },
      );
      const mcpServers = vi.fn(() => [
        {
          type: "http" as const,
          name: "f5_preview_test",
          url: "http://127.0.0.1:1234/mcp/preview",
          headers: [{ name: "Authorization", value: "Bearer fixture" }],
        },
      ]);
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const context = yield* Layer.build(
              AcpSessionRuntime.layer({
                spawn: { command: executable, args: [], cwd },
                cwd,
                clientInfo: { name: "test", version: "1" },
                authMethodId: "test",
                ...(branch !== "new" ? { resumeSessionId: "existing" } : {}),
                ...(branch.startsWith("resume") ? { resumeMethod: "resume" as const } : {}),
                mcpServers,
              }),
            );
            const runtime = yield* Effect.service(AcpSessionRuntime).pipe(Effect.provide(context));
            yield* runtime.start();
          }),
        ).pipe(Effect.provide(NodeServices.layer)),
      );
      const requests = (await readFile(log, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      const sessions = requests.filter((request) =>
        ["session/new", "session/load", "session/resume"].includes(request.method),
      );
      expect(sessions.length).toBe(branch.endsWith("fallback") ? 2 : 1);
      for (const request of sessions)
        expect(request.params.mcpServers).toEqual(mcpServers.mock.results[0]!.value);
      expect(mcpServers).toHaveBeenCalledOnce();
    },
  );
});

import { Exit, Scope } from "effect";
import { ThreadId } from "@t3tools/contracts";
import { prepareAcpAutomationCatalogs } from "./AcpAutomationCatalogs";
import { makePreviewMcpHttpServer } from "../../mcp/PreviewMcpHttpServer";
import {
  makePreviewAutomationBroker,
  PreviewAutomationBroker,
} from "../../mcp/PreviewAutomationBroker";

it.each(["authentication", "new-session", "configuration", "interrupted"] as const)(
  "revokes the real credential after %s failure while retaining the diagnostic scrubber",
  async (failure) => {
    const cwd = await mkdtemp(path.join(tmpdir(), "f5-acp-cleanup-"));
    const executable = writeAcpWrapper(
      path.join(cwd, "agent"),
      path.resolve("scripts/acp-mock-agent.ts"),
      {
        env: {
          ACP_MOCK_MCP_HTTP: "1",
          ...(failure === "authentication" ? { ACP_MOCK_AUTH_FAIL: "1" } : {}),
          ...(failure === "new-session" ? { ACP_MOCK_NEW_FAIL: "1" } : {}),
          ...(failure === "interrupted" ? { ACP_MOCK_NEW_HANG: "1" } : {}),
          ...(failure === "configuration" ? { T3_ACP_FAIL_SET_CONFIG_OPTION: "1" } : {}),
        },
      },
    );
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const broker = makePreviewAutomationBroker();
          yield* Effect.addFinalizer(() => broker.shutdown);
          const server = yield* makePreviewMcpHttpServer.pipe(
            Effect.provideService(PreviewAutomationBroker, broker),
          );
          const scope = yield* Scope.make();
          yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void));
          const catalogs = yield* prepareAcpAutomationCatalogs({
            threadId: ThreadId.makeUnsafe("cleanup"),
            provider: "cursor",
            verification: { preview: true },
            scope,
            preview: server,
            ordinarySession: true,
            readOnlyWorkflow: false,
          });
          const offered = vi.fn(catalogs.mcpServers);
          const context = yield* Layer.build(
            AcpSessionRuntime.layer({
              spawn: { command: executable, args: [], cwd },
              cwd,
              clientInfo: { name: "test", version: "1" },
              authMethodId: "test",
              mcpServers: offered,
            }),
          ).pipe(Effect.provideService(Scope.Scope, scope));
          const runtime = yield* Effect.service(AcpSessionRuntime).pipe(Effect.provide(context));
          const result =
            failure === "interrupted"
              ? yield* Effect.gen(function* () {
                  const starting = yield* Effect.forkScoped(Effect.asVoid(runtime.start()));
                  // Interrupt only after the credential has actually been offered.
                  // A wall-clock startup timeout can fire before initialization under load.
                  yield* Effect.promise(() =>
                    vi.waitFor(() => expect(offered).toHaveBeenCalledOnce(), { timeout: 10_000 }),
                  );
                  yield* Fiber.interrupt(starting);
                  return yield* Fiber.await(starting);
                })
              : yield* Effect.gen(function* () {
                  yield* runtime.start();
                  if (failure === "configuration") yield* runtime.setConfigOption("mode", "bad");
                }).pipe(Effect.exit);
          expect(Exit.isFailure(result)).toBe(true);
          if (failure === "authentication") yield* runtime.start().pipe(Effect.exit);
          expect(offered).toHaveBeenCalledOnce();
          const configs = catalogs.mcpServers({
            protocolVersion: 1,
            agentCapabilities: { mcpCapabilities: { http: true } },
          });
          const config = configs[0];
          if (!config || !("url" in config)) throw new Error("missing fixture catalog");
          const header = config.headers.find((entry) => entry.name === "Authorization")!.value;
          yield* Scope.close(scope, Exit.void);
          const status = yield* Effect.promise(
            async () =>
              (
                await fetch(config.url, {
                  method: "POST",
                  headers: { authorization: header, "content-type": "application/json" },
                  body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
                })
              ).status,
          );
          expect(status).toBe(401);
          expect(catalogs.scrubDiagnostic(header)).toBe("Bearer [redacted]");
        }),
      ).pipe(Effect.provide(NodeServices.layer)),
    );
  },
);

it("turns catalog callback exceptions into typed ACP failures", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "f5-acp-callback-"));
  const executable = writeAcpWrapper(
    path.join(cwd, "agent"),
    path.resolve("scripts/acp-mock-agent.ts"),
  );
  const exit = await Effect.runPromiseExit(
    Effect.scoped(
      Effect.gen(function* () {
        const context = yield* Layer.build(
          AcpSessionRuntime.layer({
            spawn: { command: executable, args: [], cwd },
            cwd,
            clientInfo: { name: "test", version: "1" },
            authMethodId: "test",
            mcpServers: () => {
              throw new Error("PRIVATE_CALLBACK_MARKER");
            },
          }),
        );
        const runtime = yield* Effect.service(AcpSessionRuntime).pipe(Effect.provide(context));
        yield* runtime.start();
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );
  expect(Exit.isFailure(exit)).toBe(true);
  if (Exit.isFailure(exit)) {
    expect(Cause.hasDies(exit.cause)).toBe(false);
    expect(String(Cause.squash(exit.cause))).toContain("ACP_MCP_CONFIGURATION_FAILED");
    expect(String(Cause.squash(exit.cause))).not.toContain("PRIVATE_CALLBACK_MARKER");
  }
});
