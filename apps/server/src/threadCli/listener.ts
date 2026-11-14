import { randomBytes } from "node:crypto";
import { Effect } from "effect";
import type { AgentBridgeHostShape } from "../agentBridge/AgentBridgeHost.ts";
import { startMcpListener, tokensEqual } from "../agentBridge/AgentBridgeListeners.ts";
import {
  removeAgentBridgeLocalCredentials,
  writeAgentBridgeLocalCredentials,
} from "../agentBridge/localCredentials.ts";
import {
  AgentBridgeToolError,
  type AgentBridgeCaller,
  type AgentBridgeToolDefinition,
} from "../agentBridge/threadTools.ts";
import { makeOwnerThreadTools } from "./tools.ts";
import { ownerCredentialsPath } from "./protocol.ts";

const BOOTSTRAP = "thread-cli-bootstrap";
const SESSION_IDLE_MS = 5 * 60_000;

/** A separate owner catalog: the bridge's opt-in and grants are never consulted or changed. */
export async function startThreadCliListener(
  host: AgentBridgeHostShape,
  stateDir: string,
  serverVersion: string,
) {
  const token = randomBytes(32).toString("base64url");
  const sessions = new Map<string, number>();
  const prune = () => {
    for (const [key, expires] of sessions) if (expires <= Date.now()) sessions.delete(key);
  };
  const caller = (id: string): AgentBridgeCaller => ({
    client: {
      id,
      kind: "local",
      name: "F5 thread CLI",
      label: null,
      scopes: ["f5.read", "f5.turns"],
      projectIds: [],
      grantGeneration: 0,
      createdAt: new Date().toISOString(),
      lastUsedAt: null,
      revokedAt: null,
    },
    visibleProjectIds: new Set(),
  });
  const sessionTool = (
    name: string,
    run: AgentBridgeToolDefinition["run"],
  ): AgentBridgeToolDefinition => ({
    name,
    title: name,
    description: "Manage a temporary local CLI credential.",
    scope: "f5.read",
    inputSchema: { type: "object", properties: {} },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
    run,
  });
  const tools = [
    sessionTool("f5_cli_open", (_args, context) =>
      Effect.suspend(() => {
        if (context.client.id !== BOOTSTRAP)
          return Effect.fail(new AgentBridgeToolError({ message: "Not a bootstrap credential." }));
        prune();
        if (sessions.size >= 64)
          return Effect.fail(
            new AgentBridgeToolError({ message: "Too many active CLI sessions." }),
          );
        const issued = randomBytes(32).toString("base64url");
        sessions.set(issued, Date.now() + SESSION_IDLE_MS);
        return Effect.succeed({ token: issued });
      }),
    ),
    sessionTool("f5_cli_close", (_args, context) =>
      Effect.sync(() => {
        sessions.delete(context.client.id);
        return {};
      }),
    ),
    ...makeOwnerThreadTools(host).map(
      (tool): AgentBridgeToolDefinition => ({
        ...tool,
        run: (args, context) =>
          context.client.id === BOOTSTRAP
            ? Effect.fail(
                new AgentBridgeToolError({ message: "Open a temporary CLI session first." }),
              )
            : tool.run(args, context),
      }),
    ),
  ];
  const listener = await startMcpListener({
    authenticate: async (provided) => {
      if (tokensEqual(token, provided)) return caller(BOOTSTRAP);
      prune();
      if (!sessions.has(provided)) return null;
      sessions.set(provided, Date.now() + SESSION_IDLE_MS);
      return caller(provided);
    },
    tools: () => tools,
    serverVersion,
  });
  const file = ownerCredentialsPath(stateDir);
  try {
    await writeAgentBridgeLocalCredentials(file, {
      port: listener.port,
      token,
      startedAt: new Date().toISOString(),
      serverPid: process.pid,
    });
  } catch (error) {
    await listener.close();
    throw error;
  }
  return {
    port: listener.port,
    close: async () => {
      sessions.clear();
      await removeAgentBridgeLocalCredentials(file, token).catch(() => undefined);
      await listener.close();
    },
  };
}
