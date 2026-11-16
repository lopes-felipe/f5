import { mkdtemp } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { Cause, Effect, Layer, Schema, Stream } from "effect";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CursorSettings,
  GrokSettings,
  ThreadId,
  type ProviderRuntimeEvent,
} from "@t3tools/contracts";
import { expect, it } from "vitest";
import { ServerConfig } from "../../config";
import { writeAcpWrapper } from "../../testUtils/cli";
import { makeCursorAdapter } from "../Layers/CursorAdapter";
import { makeGrokAdapter } from "../Layers/GrokAdapter";

it.each(["cursor", "grok", "antigravity"] as const)(
  "redacts %s update-only and derived task events with native logging disabled",
  async (provider) => {
    const cwd = await mkdtemp(path.join(tmpdir(), "f5-acp-adapter-privacy-"));
    const executable = writeAcpWrapper(
      path.join(cwd, "agent"),
      path.resolve("scripts/acp-mock-agent.ts"),
      { env: { ACP_MOCK_PRIVATE_TOOL_EVENTS: "1" } },
    );
    const events: ProviderRuntimeEvent[] = [];
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const adapter =
            provider === "cursor"
              ? yield* makeCursorAdapter(
                  Schema.decodeUnknownSync(CursorSettings)({ binaryPath: executable }),
                )
              : yield* makeGrokAdapter(
                  Schema.decodeUnknownSync(GrokSettings)({ binaryPath: executable }),
                  { provider },
                );
          yield* Stream.runForEach(adapter.streamEvents, (event) =>
            Effect.sync(() => {
              events.push(event);
            }),
          ).pipe(Effect.forkChild);
          const threadId = ThreadId.makeUnsafe(`privacy-${provider}`);
          yield* adapter.startSession({
            threadId,
            provider,
            cwd,
            runtimeMode: "full-access",
            resumeCursor: { computerCapable: true },
          });
          yield* adapter.sendTurn({ threadId, input: "run fixture", attachments: [] });
          // sendTurn completes only after its event barrier has drained notifications.
          yield* adapter.stopSession(threadId);
        }),
      ).pipe(
        Effect.provide(
          ServerConfig.layerTest(cwd, path.join(cwd, "state"), { mode: "desktop" }).pipe(
            Layer.provideMerge(NodeServices.layer),
          ),
        ),
      ),
    );
    expect(
      events.some(
        (event) => event.type === "item.completed" && event.itemId === "private-update-only",
      ),
    ).toBe(true);
    expect(events.some((event) => event.type.startsWith("task."))).toBe(false);
    expect(JSON.stringify(events)).not.toContain("PRIVATE_ADAPTER_SENTINEL");
  },
);

import * as AcpCatalogs from "./AcpAutomationCatalogs";
import { vi } from "vitest";

it("preserves Cursor session commands and configuration during catalog status refreshes", async () => {
  const original = AcpCatalogs.prepareAcpAutomationCatalogs;
  let notify!: () => void;
  const spy = vi.spyOn(AcpCatalogs, "prepareAcpAutomationCatalogs").mockImplementation((input) =>
    original(input).pipe(
      Effect.map((catalogs) => ({
        ...catalogs,
        onChanged(listener) {
          notify = listener;
          return catalogs.onChanged(listener);
        },
      })),
    ),
  );
  const cwd = await mkdtemp(path.join(tmpdir(), "f5-acp-config-refresh-"));
  const executable = writeAcpWrapper(
    path.join(cwd, "agent"),
    path.resolve("scripts/acp-mock-agent.ts"),
    { env: { F5_ACP_STARTUP_COMMANDS: "1" } },
  );
  const events: ProviderRuntimeEvent[] = [];
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const adapter = yield* makeCursorAdapter(
            Schema.decodeUnknownSync(CursorSettings)({ binaryPath: executable }),
          );
          yield* Stream.runForEach(adapter.streamEvents, (event) =>
            Effect.sync(() => {
              events.push(event);
            }),
          ).pipe(Effect.forkChild);
          const threadId = ThreadId.makeUnsafe("cursor-config-refresh");
          yield* adapter.startSession({
            threadId,
            provider: "cursor",
            cwd,
            runtimeMode: "full-access",
          });
          const configurations = () =>
            events.filter((event) => event.type === "session.configured");
          yield* Effect.promise(() =>
            vi.waitFor(() =>
              expect(
                (
                  configurations().at(-1) as
                    | Extract<ProviderRuntimeEvent, { type: "session.configured" }>
                    | undefined
                )?.payload.config.slashCommands,
              ).toEqual(expect.arrayContaining([expect.objectContaining({ name: "review" })])),
            ),
          );
          const prior = configurations().at(-1)!;
          if (prior.type !== "session.configured") throw new Error("Missing configuration");
          expect(prior.payload.config.slashCommands).toEqual(
            expect.arrayContaining([expect.objectContaining({ name: "review" })]),
          );
          const count = configurations().length;
          notify();
          yield* Effect.promise(() =>
            vi.waitFor(() => expect(configurations().length).toBeGreaterThan(count)),
          );
          const refreshed = configurations().at(-1)!;
          if (refreshed.type !== "session.configured") throw new Error("Missing configuration");
          expect(refreshed.payload.config).toMatchObject(prior.payload.config);
          yield* adapter.stopSession(threadId);
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
    spy.mockRestore();
  }
});

it.each(["cursor", "grok"] as const)(
  "keeps %s non-catalog session setup errors readable",
  async (provider) => {
    const cwd = await mkdtemp(path.join(tmpdir(), "f5-acp-setup-diagnostic-"));
    const executable = writeAcpWrapper(
      path.join(cwd, "agent"),
      path.resolve("scripts/acp-mock-agent.ts"),
      { env: { ACP_MOCK_NEW_FAIL: "1" } },
    );
    const exit = await Effect.runPromiseExit(
      Effect.scoped(
        Effect.gen(function* () {
          const adapter =
            provider === "cursor"
              ? yield* makeCursorAdapter(
                  Schema.decodeUnknownSync(CursorSettings)({ binaryPath: executable }),
                )
              : yield* makeGrokAdapter(
                  Schema.decodeUnknownSync(GrokSettings)({ binaryPath: executable }),
                );
          yield* adapter.startSession({
            threadId: ThreadId.makeUnsafe("setup-diagnostic"),
            provider,
            cwd,
            runtimeMode: "full-access",
          });
        }),
      ).pipe(
        Effect.provide(
          ServerConfig.layerTest(cwd, path.join(cwd, "state")).pipe(
            Layer.provideMerge(NodeServices.layer),
          ),
        ),
      ),
    );
    if (exit._tag !== "Failure") throw new Error("Expected setup failure");
    expect(String(Cause.squash(exit.cause))).toContain("Mock session failed");
    expect(String(Cause.squash(exit.cause))).not.toContain("ACP_REQUEST_FAILED");
  },
);
