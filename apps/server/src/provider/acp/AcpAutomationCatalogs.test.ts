import { describe, expect, it, vi } from "vitest";
import { Effect, Exit, Scope } from "effect";
import { ThreadId } from "@t3tools/contracts";
import { automationEventSanitizer } from "@t3tools/shared/automationActivitySanitizer";
import {
  prepareAcpAutomationCatalogs,
  createAcpComputerClassifier,
  classifyAcpToolEvent,
} from "./AcpAutomationCatalogs";
import type { InitializeResponse } from "effect-acp/schema";
import type { PreviewMcpHttpServerShape } from "../../mcp/PreviewMcpHttpServer";
const threadId = ThreadId.makeUnsafe("catalog-test");
const init = {
  protocolVersion: 1,
  agentCapabilities: { mcpCapabilities: { http: true } },
} as InitializeResponse;

describe("ACP catalogs and privacy", () => {
  it("offers thread tools on the web without installing desktop automation catalogs", async () => {
    const dispose = vi.fn();
    const createSessionConfig = vi.fn(() => ({
      serverName: "f5_thread",
      env: { THREAD_TOKEN: "thread-private-token" },
      serverDefinition: {
        type: "http",
        url: "http://127.0.0.1:1234/mcp/thread",
        bearerTokenEnvVar: "THREAD_TOKEN",
      },
      dispose,
    }));
    const scope = await Effect.runPromise(Scope.make());
    const catalogs = await Effect.runPromise(
      prepareAcpAutomationCatalogs({
        threadId,
        provider: "cursor",
        scope,
        ordinarySession: false,
        threadSession: true,
        readOnlyWorkflow: false,
        preview: {
          supportsThreadCatalog: true,
          createSessionConfig,
        } as unknown as PreviewMcpHttpServerShape,
      }),
    );
    expect(catalogs.mcpServers(init)).toHaveLength(1);
    expect(createSessionConfig).toHaveBeenCalledWith(
      expect.objectContaining({ catalog: "thread" }),
    );
    await Effect.runPromise(Scope.close(scope, Exit.void));
    expect(dispose).toHaveBeenCalledOnce();
  });
  it.each([true, false])(
    "offers thread tools only to an ordinary HTTP-capable agent (%s)",
    async (http) => {
      const dispose = vi.fn();
      const createSessionConfig = vi.fn(() => ({
        serverName: "f5_thread",
        env: { THREAD_TOKEN: "thread-private-token" },
        serverDefinition: {
          type: "http",
          url: "http://127.0.0.1:1234/mcp/thread",
          bearerTokenEnvVar: "THREAD_TOKEN",
        },
        dispose,
      }));
      const scope = await Effect.runPromise(Scope.make());
      const catalogs = await Effect.runPromise(
        prepareAcpAutomationCatalogs({
          threadId,
          provider: "cursor",
          scope,
          ordinarySession: true,
          readOnlyWorkflow: false,
          preview: {
            supportsThreadCatalog: true,
            createSessionConfig,
          } as unknown as PreviewMcpHttpServerShape,
        }),
      );
      const offered = catalogs.mcpServers({
        ...init,
        agentCapabilities: { mcpCapabilities: { http } },
      });
      expect(offered).toHaveLength(http ? 1 : 0);
      if (http)
        expect(createSessionConfig).toHaveBeenCalledWith(
          expect.objectContaining({ threadId, catalog: "thread" }),
        );
      await Effect.runPromise(Scope.close(scope, Exit.void));
      expect(dispose).toHaveBeenCalledTimes(http ? 1 : 0);
      if (http)
        expect(
          JSON.stringify(catalogs.redactForLog({ error: "thread-private-token" })),
        ).not.toContain("thread-private-token");
    },
  );
  it.each([
    { kind: "execute", rawInput: { text: "marker" } },
    { kind: "read", rawInput: { input: { tool: "computer_type", text: "marker" } } },
    { kind: "read" },
    { kind: "execute", rawInput: { params: { appId: "marker" } } },
  ])("classifies uncertain tool calls conservatively (%s)", (call) => {
    const serverName = "f5_computer_fixture";
    automationEventSanitizer.register(threadId, {
      serverName,
      verified: true,
      kind: "f5-computer",
    });
    const classify = createAcpComputerClassifier(threadId, serverName, () => true);
    expect(classify({ toolCallId: "call", ...call })).toBe(true);
    expect(
      classify({ toolCallId: "call", kind: "execute", rawInput: { command: "echo safe" } }),
    ).toBe(true);
    automationEventSanitizer.clear(threadId);
  });
  it("keeps native commands native, treats unknown update IDs as computer and never proves identity from a look-alike name", () => {
    automationEventSanitizer.register(threadId, {
      serverName: "f5_computer_fixture",
      verified: true,
      kind: "f5-computer",
    });
    const classify = createAcpComputerClassifier(threadId, "f5_computer_fixture", () => true);
    expect(
      classify({ toolCallId: "native", kind: "execute", rawInput: { command: "echo safe" } }),
    ).toBe(false);
    expect(classify({ toolCallId: "native", status: "completed" }, true)).toBe(false);
    expect(classify({ toolCallId: "native", title: "computer_type" }, true)).toBe(true);

    expect(
      classify({ toolCallId: "unseen", kind: "execute", rawInput: { command: "echo safe" } }, true),
    ).toBe(true);
    expect(
      classify({ toolCallId: "fake", title: "mcp__f5_computer_fake__computer_type", rawInput: {} }),
    ).toBe(true);
    automationEventSanitizer.clear(threadId);
  });
  it.each([true, false])(
    "memoizes the transport catalog, gates computer independently and scrubs credentials after disposal (HTTP %s)",
    async (http) => {
      const dispose = vi.fn();
      const createSessionConfig = vi.fn(({ serverName }: { serverName?: string }) => ({
        serverName: serverName!,
        env: { TOKEN: "issued-test-credential" },
        serverDefinition: {
          type: "http" as const,
          url: "http://127.0.0.1:1234/mcp/preview",
          bearerTokenEnvVar: "TOKEN",
        },
        dispose,
      }));
      const scope = await Effect.runPromise(Scope.make());
      const catalogs = await Effect.runPromise(
        prepareAcpAutomationCatalogs({
          threadId,
          provider: "cursor",
          verification: { preview: true },
          scope,
          ordinarySession: true,
          readOnlyWorkflow: false,
          preview: { createSessionConfig } as unknown as PreviewMcpHttpServerShape,
        }),
      );
      const offered = catalogs.mcpServers({
        ...init,
        agentCapabilities: { mcpCapabilities: { http } },
      });
      expect(catalogs.mcpServers(init)).toBe(offered);
      expect(offered).toHaveLength(http ? 1 : 0);
      if (http)
        expect(offered[0]).toMatchObject({
          type: "http",
          name: expect.stringMatching(/^f5_preview_[a-f0-9]{8}$/),
          headers: [{ name: "Authorization", value: "Bearer issued-test-credential" }],
        });
      expect(JSON.stringify(catalogs.agentBrowser())).toContain("awaiting verification");
      await Effect.runPromise(Scope.close(scope, Exit.void));
      catalogs.dispose();
      expect(dispose).toHaveBeenCalledTimes(http ? 1 : 0);
      expect(
        JSON.stringify(catalogs.redactForLog({ echoedError: "issued-test-credential" })),
      ).not.toContain(http ? "issued-test-credential" : "impossible-marker");
    },
  );
  it("retains conservative replay redaction across generation replacement before logs or enqueue", async () => {
    const scope = await Effect.runPromise(Scope.make());
    const catalogs = await Effect.runPromise(
      prepareAcpAutomationCatalogs({
        threadId,
        provider: "cursor",
        scope,
        ordinarySession: true,
        readOnlyWorkflow: false,
        computerCapableLineage: true,
      }),
    );
    const frame = {
      method: "session/update",
      params: {
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId: "previous-call",
          rawOutput: { text: "private-marker" },
          title: "private-marker",
          rawInput: { text: "private-marker" },
        },
      },
    };
    expect(JSON.stringify(catalogs.redactForLog(JSON.stringify(frame)))).not.toContain(
      "private-marker",
    );
    expect(automationEventSanitizer.isComputerItem(threadId, "previous-call")).toBe(true);
    const permission = {
      method: "session/request_permission",
      params: {
        toolCall: {
          toolCallId: "permission",
          kind: "execute",
          rawInput: { text: "private-marker" },
        },
      },
    };
    expect(JSON.stringify(catalogs.redactForLog(permission))).not.toContain("private-marker");
    await Effect.runPromise(Scope.close(scope, Exit.void));
  });
});

it.each(["cursor", "grok"] as const)(
  "classifies %s update-only notifications before redaction with native logging disabled",
  async (provider) => {
    const scope = await Effect.runPromise(Scope.make());
    const catalogs = await Effect.runPromise(
      prepareAcpAutomationCatalogs({
        threadId,
        provider,
        scope,
        ordinarySession: true,
        readOnlyWorkflow: false,
        computerCapableLineage: true,
      }),
    );
    try {
      const update = {
        sessionUpdate: "tool_call_update",
        toolCallId: "update-only",
        kind: "execute",
        rawInput: { command: "echo safe" },
        rawOutput: "PRIVATE_UPDATE_MARKER",
      };
      expect(
        classifyAcpToolEvent(catalogs, {
          rawPayload: { update },
          toolCall: { toolCallId: update.toolCallId, data: update },
        }),
      ).toBe(true);
      expect(
        JSON.stringify(catalogs.redactForLog({ method: "session/update", params: { update } })),
      ).not.toContain("PRIVATE_UPDATE_MARKER");
    } finally {
      await Effect.runPromise(Scope.close(scope, Exit.void));
    }
  },
);
it("installs no preview catalog before harness verification", async () => {
  const scope = await Effect.runPromise(Scope.make());
  const createSessionConfig = vi.fn();
  try {
    const catalogs = await Effect.runPromise(
      prepareAcpAutomationCatalogs({
        threadId,
        provider: "cursor",
        scope,
        ordinarySession: true,
        readOnlyWorkflow: false,
        preview: { createSessionConfig } as never,
      }),
    );
    expect(catalogs.mcpServers(init)).toEqual([]);
    expect(createSessionConfig).not.toHaveBeenCalled();
  } finally {
    await Effect.runPromise(Scope.close(scope, Exit.void));
  }
});

it.each([
  [{ readOnlyWorkflow: true, ordinarySession: true }, "read-only workflows"],
  [{ readOnlyWorkflow: false, ordinarySession: false }, "ordinary F5 desktop session"],
])("reports ineligible verified sessions accurately (%s)", async (eligibility, reason) => {
  const scope = await Effect.runPromise(Scope.make());
  const createSessionConfig = vi.fn();
  try {
    const catalogs = await Effect.runPromise(
      prepareAcpAutomationCatalogs({
        threadId,
        provider: "cursor",
        scope,
        ...eligibility,
        verification: { computer: true },
        preview: { createSessionConfig } as never,
      }),
    );
    expect(catalogs.mcpServers(init)).toEqual([]);
    expect(createSessionConfig).not.toHaveBeenCalled();
    expect(JSON.stringify(catalogs.agentBrowser())).toContain(reason);
  } finally {
    await Effect.runPromise(Scope.close(scope, Exit.void));
  }
});
