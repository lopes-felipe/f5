import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Effect, Fiber, Layer, Schema, Stream } from "effect";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  ApprovalRequestId,
  CursorSettings,
  GrokSettings,
  ThreadId,
  type ProviderRuntimeEvent,
} from "@t3tools/contracts";
import { describe, expect, it } from "vitest";
import { ComputerAutomationBroker } from "../src/computer/ComputerAutomationBroker";
import { makePreviewMcpHttpServer } from "../src/mcp/PreviewMcpHttpServer";
import {
  makePreviewAutomationBroker,
  PreviewAutomationBroker,
} from "../src/mcp/PreviewAutomationBroker";
import { makeCursorAdapter } from "../src/provider/Layers/CursorAdapter";
import { makeGrokAdapter } from "../src/provider/Layers/GrokAdapter";
import { makeAntigravityAcpRuntime } from "../src/provider/acp/AntigravityAcpSupport";
import type { EventNdjsonLogger } from "../src/provider/Layers/EventNdjsonLogger";
import { ServerConfig } from "../src/config";
import { computerHostFixture } from "./computer/hostFixture";

const selected = process.env.F5_ACP_COMPUTER_LIVE;
const provider =
  selected === "cursor" || selected === "grok" || selected === "antigravity" ? selected : undefined;
/** Explicit opt-in: consumes the selected account's quota; only a simulated host receives input. */
describe.skipIf(!provider)("live ACP computer transport and privacy", () => {
  it("discovers the authenticated catalog, waits for fixture consent, types only into the fixture, and keeps tool activities/logs private", async () => {
    const harness = provider!;
    const fixture = await computerHostFixture({ modern: true, consentDelayMs: 5500 });
    const cwd = await mkdtemp(path.join(tmpdir(), "f5-acp-computer-live-"));
    const marker = `F5_PRIVATE_${crypto.randomUUID().replaceAll("-", "")}`;
    const events: ProviderRuntimeEvent[] = [];
    const logs: unknown[] = [];
    const logger: EventNdjsonLogger = {
      filePath: "fixture",
      write: (event) =>
        Effect.sync(() => {
          logs.push(event);
        }),
      close: () => Effect.void,
    };

    let failure: unknown;
    const startedAt = Date.now();
    try {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const preview = makePreviewAutomationBroker();
            yield* Effect.addFinalizer(() => preview.shutdown);
            const server = yield* makePreviewMcpHttpServer.pipe(
              Effect.provideService(PreviewAutomationBroker, preview),
              Effect.provideService(ComputerAutomationBroker, fixture.broker),
            );
            const common = {
              automationCatalogVerification: { preview: true, computer: true },
              environment: process.env,
              nativeEventLogger: logger,
              previewMcpHttpServer: server,
              computerAutomationBroker: fixture.broker,
            };
            const adapter =
              harness === "cursor"
                ? yield* makeCursorAdapter(Schema.decodeUnknownSync(CursorSettings)({}), common)
                : yield* makeGrokAdapter(Schema.decodeUnknownSync(GrokSettings)({}), {
                    ...common,
                    provider: harness,
                    ...(harness === "antigravity"
                      ? {
                          makeRuntime: (input) =>
                            makeAntigravityAcpRuntime({
                              ...input,
                              stateDir: process.env.F5_ACP_ANTIGRAVITY_STATE_DIR ?? cwd,
                              instanceId: "antigravity",
                              environment: process.env,
                            }),
                        }
                      : {}),
                  });
            const threadId = ThreadId.makeUnsafe("acp-computer-live");
            const consumer = yield* Stream.runForEach(adapter.streamEvents, (event) =>
              Effect.gen(function* () {
                events.push(event);
                if (event.type === "turn.started" && event.turnId) fixture.setTurn(event.turnId);
                // Simulated human answer, after observing the sanitized prompt. No full-access shortcut.
                if (event.type === "request.opened" && event.requestId)
                  yield* adapter.respondToRequest(
                    threadId,
                    ApprovalRequestId.makeUnsafe(event.requestId),
                    "accept",
                  );
              }),
            ).pipe(Effect.forkChild);
            yield* adapter.startSession({ threadId, cwd, runtimeMode: "full-access" });
            yield* adapter.sendTurn({
              threadId,
              input: `Use only the F5 computer MCP tools. This is a simulated host, so no real OS input is possible. Call computer_status, request access to F5 transport test app with reason Protocol test, then computer_type with app F5 transport test app and text ${marker}. Finish with READY without quoting the text.`,
              attachments: [],
            });
            const configured = events.filter((event) => event.type === "session.configured");
            expect(JSON.stringify(configured)).toContain("f5_computer_");
            expect(
              fixture.seen.some((request) => request.op === "type" && request.text === marker),
            ).toBe(true);
            expect(Date.now() - startedAt).toBeGreaterThan(5000);
            const activities = events.filter(
              (event) =>
                event.type.startsWith("request.") ||
                (event.type.startsWith("item.") &&
                  "payload" in event &&
                  "itemType" in event.payload &&
                  event.payload.itemType !== "assistant_message"),
            );
            expect(activities.length).toBeGreaterThan(0);
            expect(logs.length).toBeGreaterThan(0);
            expect(JSON.stringify(logs)).toContain("session/update");
            expect(JSON.stringify(logs)).not.toContain(marker);
            expect(JSON.stringify(activities)).not.toContain(marker);
            const generation = fixture.broker.generation(threadId)!;
            fixture.setTurn("plan-check");
            fixture.setInteractionMode("plan");
            yield* Effect.promise(async () => {
              expect(
                await fixture.broker.invoke(threadId, generation, {
                  op: "screenshot",
                  displayId: "test-display",
                }),
              ).toBeDefined();
            });
            yield* Effect.promise(async () => {
              await expect(
                fixture.broker.invoke(threadId, generation, { op: "type", text: "must-not-run" }),
              ).rejects.toThrow("plan mode");
            });
            fixture.broker.setPaused(threadId, true);
            yield* Effect.promise(async () => {
              await expect(
                fixture.broker.invoke(threadId, generation, {
                  op: "screenshot",
                  displayId: "test-display",
                }),
              ).rejects.toThrow("Interrupted");
            });
            yield* adapter.stopSession(threadId);
            expect(fixture.broker.generation(threadId)).toBeUndefined();
            yield* Effect.promise(async () => {
              await expect(
                fixture.broker.invoke(threadId, generation, { op: "type", text: "late-replay" }),
              ).rejects.toThrow("Interrupted");
            });
            yield* Fiber.interrupt(consumer);
          }),
        ).pipe(
          Effect.provide(
            ServerConfig.layerTest(cwd, path.join(cwd, "state"), { mode: "desktop" }).pipe(
              Layer.provideMerge(NodeServices.layer),
            ),
          ),
          Effect.timeout("150 seconds"),
        ),
      );
    } catch (error) {
      failure = error;
      throw error;
    } finally {
      fixture.broker.close();
      if (process.env.F5_ACP_COMPUTER_REPORT)
        await writeFile(
          process.env.F5_ACP_COMPUTER_REPORT,
          JSON.stringify(
            {
              provider: harness,
              at: new Date().toISOString(),
              status: failure ? "failed" : "transport-privacy-passed",
              flagEligible: false,
              pending: [
                "live harness plan-mode observation",
                "held foreground takeover",
                "unrelated-session attribution",
                "signed desktop checks",
              ],
              nativeLogCount: logs.length,
              eventCount: events.length,
            },
            null,
            2,
          ) + "\n",
        );
    }
  }, 160_000);
});
