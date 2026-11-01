import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ThreadId } from "@t3tools/contracts";
import { Effect, Exit, Scope } from "effect";
import { expect, it } from "vitest";
import { makeThreadMcpBroker } from "../../mcp/threadMcpTools.ts";
import { evaluateClaudeMandatoryPolicy } from "../claudeMandatoryPolicy.ts";
import { isF5ThreadReadTool, makeClaudeThreadMcpServer } from "./claudeThreadTools.ts";

it("keeps native thread tools available after a parent turn ends and revokes the runtime owner", async () => {
  const scope = await Effect.runPromise(Scope.make());
  const broker = await Effect.runPromise(makeThreadMcpBroker);
  const threadId = ThreadId.makeUnsafe("native-agent-parent");
  let activeTurnId: string | null = "parent-turn";
  const seen: string[] = [];
  await Effect.runPromise(
    broker
      .register((id) =>
        Effect.sync(() => {
          seen.push(id);
          return { threadId: id, activeTurnId };
        }),
      )
      .pipe(Effect.provideService(Scope.Scope, scope)),
  );
  const server = makeClaudeThreadMcpServer({ broker, threadId, existingServerNames: new Set() });
  const client = new Client({ name: "native-background-agent", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([
      server.config.instance.connect(serverTransport),
      client.connect(clientTransport),
    ]);
    const invoke = () =>
      client.callTool({ name: "thread_status", arguments: { threadId: "another-thread" } });
    expect((await invoke()).structuredContent).toEqual({ threadId, activeTurnId: "parent-turn" });
    activeTurnId = null;
    const background = await invoke();
    expect(background.isError).not.toBe(true);
    expect(background.structuredContent).toEqual({ threadId, activeTurnId: null });
    expect(seen).toEqual([threadId, threadId]);
    await Effect.runPromise(Scope.close(scope, Exit.void));
    expect((await invoke()).isError).toBe(true);
    expect(seen).toHaveLength(2);
  } finally {
    await Promise.allSettled([
      client.close(),
      server.config.instance.close(),
      Effect.runPromise(Scope.close(scope, Exit.void)),
    ]);
  }
});

it("lists only thread_read on a read-only thread server", async () => {
  const broker = await Effect.runPromise(makeThreadMcpBroker);
  const server = makeClaudeThreadMcpServer({
    broker,
    threadId: ThreadId.makeUnsafe("workflow-stage"),
    existingServerNames: new Set(),
    access: "read-only",
  });
  const client = new Client({ name: "workflow-stage", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([
      server.config.instance.connect(serverTransport),
      client.connect(clientTransport),
    ]);
    expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual(["thread_read"]);
  } finally {
    await Promise.allSettled([client.close(), server.config.instance.close()]);
  }
});

it("recognizes only F5's own thread_read", () => {
  const tool = "mcp__f5_thread__thread_read";
  expect(isF5ThreadReadTool(tool, undefined, "f5_thread")).toBe(true);
  expect(isF5ThreadReadTool(tool, { source: "sdk", name: "f5_thread" }, "f5_thread")).toBe(true);
  expect(isF5ThreadReadTool(tool, { source: "stdio", name: "f5_thread" }, "f5_thread")).toBe(false);
  expect(isF5ThreadReadTool(tool, { source: "sdk", name: "other" }, "f5_thread")).toBe(false);
  expect(isF5ThreadReadTool("mcp__f5_thread__thread_settle", undefined, "f5_thread")).toBe(false);
  expect(isF5ThreadReadTool(tool, undefined, "f5_thread_2")).toBe(false);

  // The workflow permission path allows F5's thread_read and denies an impersonator.
  const policy = {
    workflowExecutionProfile: "unattended-readonly" as const,
    allowReadOnlyMcpTool: (name: string, mcpServer?: { source: string; name: string }) =>
      isF5ThreadReadTool(name, mcpServer, "f5_thread"),
  };
  expect(
    evaluateClaudeMandatoryPolicy(policy, tool, { source: "sdk", name: "f5_thread" }),
  ).toBeUndefined();
  expect(
    evaluateClaudeMandatoryPolicy(policy, tool, { source: "stdio", name: "f5_thread" }),
  ).toContain("not permitted");
});
