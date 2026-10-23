import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ThreadId } from "@t3tools/contracts";
import { Effect, Exit, Scope } from "effect";
import { expect, it } from "vitest";
import { makeThreadMcpBroker } from "../../mcp/threadMcpTools.ts";
import { makeClaudeThreadMcpServer } from "./claudeThreadTools.ts";

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
