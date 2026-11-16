import { mkdtemp, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { Effect, Layer, Schema, Stream } from "effect";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { CursorSettings, ThreadId, type ProviderRuntimeEvent } from "@t3tools/contracts";
import { expect, it } from "vitest";
import { ServerConfig } from "../src/config";
import { makeCursorAdapter } from "../src/provider/Layers/CursorAdapter";
import { makePreviewMcpHttpServer } from "../src/mcp/PreviewMcpHttpServer";
import {
  makePreviewAutomationBroker,
  PreviewAutomationBroker,
} from "../src/mcp/PreviewAutomationBroker";

/** Opt-in control and preview-only comparison. No desktop computer scope or native input. */
it.skipIf(process.env.F5_ACP_PREVIEW_LIVE !== "cursor").each([false, true])(
  "starts Cursor with preview installation %s",
  async (previewEnabled) => {
    const cwd = await mkdtemp(path.join(tmpdir(), "f5-acp-preview-live-"));
    const events: ProviderRuntimeEvent[] = [];
    const stages: Array<{ method: string; status: string }> = [];
    let passed = false;
    try {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const broker = makePreviewAutomationBroker();
            yield* Effect.addFinalizer(() => broker.shutdown);
            const server = yield* makePreviewMcpHttpServer.pipe(
              Effect.provideService(PreviewAutomationBroker, broker),
            );
            const adapter = yield* makeCursorAdapter(Schema.decodeUnknownSync(CursorSettings)({}), {
              environment: process.env,
              automationCatalogVerification: { preview: previewEnabled, computer: false },
              previewMcpHttpServer: server,
              nativeEventLogger: {
                filePath: "fixture",
                close: () => Effect.void,
                write: (value: unknown) =>
                  Effect.sync(() => {
                    const payload = (
                      value as {
                        event?: { kind?: string; payload?: { method?: unknown; status?: unknown } };
                      }
                    ).event;
                    if (
                      payload?.kind === "request" &&
                      typeof payload.payload?.method === "string" &&
                      typeof payload.payload.status === "string"
                    )
                      stages.push({
                        method: payload.payload.method,
                        status: payload.payload.status,
                      });
                  }),
              },
            });
            yield* Stream.runForEach(adapter.streamEvents, (event) =>
              Effect.sync(() => {
                events.push(event);
              }),
            ).pipe(Effect.forkChild);
            const threadId = ThreadId.makeUnsafe("acp-preview-live");
            yield* adapter
              .startSession({ threadId, provider: "cursor", cwd, runtimeMode: "approval-required" })
              .pipe(Effect.timeout("25 seconds"));
            if (previewEnabled) {
              // Listing the actual inventory verifies the model sees the catalog without executing a tool.
              yield* adapter
                .sendTurn({
                  threadId,
                  input:
                    "List the names of your available tools beginning preview_. Do not execute any tools.",
                  attachments: [],
                })
                .pipe(Effect.timeout("30 seconds"));
              expect(JSON.stringify(events)).toContain("preview_status");
            }
            yield* adapter.stopSession(threadId);
            passed = true;
          }),
        ).pipe(
          Effect.provide(
            ServerConfig.layerTest(cwd, path.join(cwd, "state"), { mode: "desktop" }).pipe(
              Layer.provideMerge(NodeServices.layer),
            ),
          ),
        ),
      );
    } finally {
      if (process.env.F5_ACP_PREVIEW_REPORT)
        await writeFile(
          `${process.env.F5_ACP_PREVIEW_REPORT}-${previewEnabled ? "preview" : "control"}.json`,
          JSON.stringify(
            {
              at: new Date().toISOString(),
              provider: "cursor",
              previewEnabled,
              status: passed ? "passed" : "failed",
              stages,
              eventCount: events.length,
              flagEligible: passed && previewEnabled,
            },
            null,
            2,
          ) + "\n",
          { flag: "wx" },
        );
    }
  },
  70_000,
);
