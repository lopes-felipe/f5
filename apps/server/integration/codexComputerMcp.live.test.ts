import { mkdtemp, mkdir, copyFile, chmod, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ThreadId, type ProviderEvent } from "@t3tools/contracts";
import { translateMcpForCodex } from "@t3tools/shared/mcpTranslation";
import { Effect } from "effect";
import { expect, it } from "vitest";
import { CodexAppServerManager } from "../src/codexAppServerManager";
import { ComputerAutomationBroker } from "../src/computer/ComputerAutomationBroker";
import { makePreviewMcpHttpServer } from "../src/mcp/PreviewMcpHttpServer";
import {
  makePreviewAutomationBroker,
  PreviewAutomationBroker,
} from "../src/mcp/PreviewAutomationBroker";
import { computerHostFixture } from "./computer/hostFixture";

// Model-backed transport test only; the test host never emits OS input.
it.skipIf(process.env.F5_CODEX_LIVE_TEST !== "1")(
  "discovers Codex computer tools and records any extra MCP approval prompt",
  async () => {
    const binary = process.env.CODEX_BINARY_PATH;
    const sourceHome = process.env.F5_CODEX_CERTIFICATION_HOME ?? process.env.CODEX_HOME;
    if (!binary || !sourceHome)
      throw new Error("Set CODEX_BINARY_PATH and F5_CODEX_CERTIFICATION_HOME (or CODEX_HOME).");
    const temporary = await mkdtemp(join(tmpdir(), "f5-codex-computer-live-"));
    const home = join(temporary, "home");
    const cwd = join(temporary, "workspace");
    const manager = new CodexAppServerManager();
    const fixture = await computerHostFixture();
    const preview = makePreviewAutomationBroker();
    const approvalMethods: string[] = [];
    const threadId = ThreadId.makeUnsafe("codex-computer-live");
    let complete: () => void = () => {};
    const completion = new Promise<void>((resolve) => {
      complete = resolve;
    });
    const events: ProviderEvent[] = [];
    manager.on("event", (event) => {
      events.push(event);
      if (event.kind === "request" && event.requestId) {
        approvalMethods.push(event.method);
        // Additional provider approval remains visible; this fixture denies unexpected tools.
        void manager.respondToRequest(threadId, event.requestId, "decline").catch(() => {});
      }
      if (event.method === "turn/completed") complete();
    });
    try {
      await mkdir(home);
      await mkdir(cwd);
      await copyFile(join(sourceHome, "auth.json"), join(home, "auth.json"));
      await chmod(join(home, "auth.json"), 0o600);
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            yield* Effect.addFinalizer(() => Effect.sync(() => fixture.broker.close()));
            yield* Effect.addFinalizer(() => preview.shutdown);
            const server = yield* makePreviewMcpHttpServer.pipe(
              Effect.provideService(PreviewAutomationBroker, preview),
              Effect.provideService(ComputerAutomationBroker, fixture.broker),
            );
            const session = server.createSessionConfig({ threadId, catalog: "computer" });
            yield* Effect.promise(async () => {
              await manager.startSession({
                threadId,
                cwd,
                runtimeMode: "full-access",
                disablePlugins: true,
                providerOptions: { codex: { binaryPath: binary, homePath: home } },
                mcpServers:
                  translateMcpForCodex({
                    [session.serverName]: session.serverDefinition,
                  }) ?? {},
                mcpEnvironment: session.env,
              });
              await manager.sendTurn({
                threadId,
                input:
                  "This is a simulated transport fixture, not a real desktop. Use the computer tools to call computer_status, computer_request_access for F5 transport test app (reason Protocol test), computer_screenshot, then computer_click x=0 y=0. Finish with READY. Use no shell or other tools.",
                effort: "low",
              });
              let timer: ReturnType<typeof setTimeout> | undefined;
              try {
                await Promise.race([
                  completion,
                  new Promise<never>((_, reject) => {
                    timer = setTimeout(
                      () => reject(new Error("Computer transport turn timed out")),
                      110_000,
                    );
                  }),
                ]);
              } finally {
                if (timer) clearTimeout(timer);
              }
              expect(fixture.seen.map((request) => request.op)).toEqual(
                expect.arrayContaining(["resolveApps", "screenshot", "click"]),
              );
              expect(fixture.consentCount()).toBeGreaterThan(0);
              fixture.broker.setPaused(threadId, true);
              expect(fixture.seen.some((request) => request.op === "type")).toBe(false);
              console.info(
                JSON.stringify({
                  computerTransport: "passed",
                  additionalApprovalMethods: approvalMethods,
                  turnCompleted: events.some((event) => event.method === "turn/completed"),
                }),
              );
              session.dispose();
            });
          }),
        ),
      );
    } finally {
      manager.stopAll();
      fixture.broker.close();
      await Effect.runPromise(preview.shutdown);
      await rm(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  },
  120_000,
);
