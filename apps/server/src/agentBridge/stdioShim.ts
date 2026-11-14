/**
 * `t3 agent-bridge-stdio`: forwards each stdin JSON-RPC line to the local
 * Agent Bridge listener as `POST /mcp` and writes each reply to stdout.
 * `local.json` is re-read for every request, so an F5 restart (which rotates
 * the token and port) needs no client reconfiguration.
 *
 * @module agentBridge/stdioShim
 */
import type { Readable, Writable } from "node:stream";

import { Utf8Lines } from "@t3tools/shared/utf8Lines";

import { jsonRpcError, jsonRpcSuccess, type JsonRpcRequest } from "../mcp/jsonRpcHttp.ts";
import { AGENT_PROCESS_ENV } from "../providerProcessEnv.ts";
import { readAgentBridgeLocalCredentials } from "./localCredentials.ts";
import { isAncestorProcess } from "./processAncestry.ts";
import { AGENT_BRIDGE_MCP_PATH } from "./AgentBridgeListeners.ts";
import {
  AGENT_BRIDGE_SERVER_INFO,
  AGENT_BRIDGE_SUPPORTED_MCP_VERSIONS,
  MCP_VERSION_INITIALIZE,
} from "./mcpProtocol.ts";

/** JSON-RPC error for "F5 or the bridge is not reachable". */
export const AGENT_BRIDGE_UNAVAILABLE_CODE = -32002;
const REQUEST_TIMEOUT_MS = 120_000;
const UNAVAILABLE_MESSAGE =
  "F5 Agent Bridge is not running. Open F5 and turn on the Agent Bridge in Settings > Integrations.";
const AGENT_PROCESS_MESSAGE = "F5 Agent Bridge is not available to agents that F5 itself runs.";

export interface AgentBridgeStdioOptions {
  readonly credentialsPath: string;
  readonly input: Readable;
  readonly output: Writable;
  readonly env?: NodeJS.ProcessEnv;
  readonly fetch?: typeof fetch;
  /** Whether the F5 server process is an ancestor of this shim. */
  readonly isServerAncestor?: (serverPid: number) => boolean;
}

/**
 * Replies served without contacting F5 when the shim runs inside one of F5's
 * own agent processes. The ChatGPT desktop app and the Codex CLI share
 * `~/.codex/config.toml`, so F5's Codex agents would otherwise see the bridge.
 *
 * Best effort, not a security boundary: an agent with shell access runs as the
 * same user and can read `local.json` itself.
 */
function recursionGuardReply(request: JsonRpcRequest) {
  switch (request.method) {
    case "initialize":
      return jsonRpcSuccess(request.id, {
        protocolVersion: MCP_VERSION_INITIALIZE,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { ...AGENT_BRIDGE_SERVER_INFO, version: "0.0.0" },
        instructions: AGENT_PROCESS_MESSAGE,
      });
    case "server/discover":
      return jsonRpcSuccess(request.id, {
        supportedVersions: [...AGENT_BRIDGE_SUPPORTED_MCP_VERSIONS],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { ...AGENT_BRIDGE_SERVER_INFO, version: "0.0.0" },
        instructions: AGENT_PROCESS_MESSAGE,
      });
    case "ping":
      return jsonRpcSuccess(request.id, {});
    case "tools/list":
      return jsonRpcSuccess(request.id, { tools: [] });
    default:
      return jsonRpcError(request.id, AGENT_BRIDGE_UNAVAILABLE_CODE, AGENT_PROCESS_MESSAGE);
  }
}

export async function runAgentBridgeStdio(options: AgentBridgeStdioOptions): Promise<void> {
  const env = options.env ?? process.env;
  const fetchImpl = options.fetch ?? fetch;
  const markedAgent = env[AGENT_PROCESS_ENV] === "1";
  const isServerAncestor = options.isServerAncestor ?? ((pid: number) => isAncestorProcess(pid));
  const ancestry = new Map<number, boolean>();
  const runsUnderServer = (serverPid: number) => {
    let known = ancestry.get(serverPid);
    if (known === undefined) {
      known = isServerAncestor(serverPid);
      ancestry.set(serverPid, known);
    }
    return known;
  };
  let negotiatedVersion: string | undefined;
  const pending = new Set<Promise<void>>();

  const write = (message: unknown) => {
    options.output.write(`${JSON.stringify(message)}\n`);
  };

  const forward = async (request: JsonRpcRequest, line: string): Promise<void> => {
    const isNotification = request.id === undefined;
    const fail = (message: string) => {
      if (!isNotification) write(jsonRpcError(request.id, AGENT_BRIDGE_UNAVAILABLE_CODE, message));
    };
    const refuse = () => {
      if (!isNotification) write(recursionGuardReply(request));
    };
    if (markedAgent) return refuse();
    const credentials = await readAgentBridgeLocalCredentials(options.credentialsPath);
    if (!credentials) return fail(UNAVAILABLE_MESSAGE);
    // The marker does not survive every launcher; the process tree does.
    if (credentials.serverPid !== undefined && runsUnderServer(credentials.serverPid))
      return refuse();
    let response: Response;
    try {
      response = await fetchImpl(`http://127.0.0.1:${credentials.port}${AGENT_BRIDGE_MCP_PATH}`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${credentials.token}`,
          "content-type": "application/json",
          accept: "application/json",
          ...(negotiatedVersion && request.method !== "initialize"
            ? { "mcp-protocol-version": negotiatedVersion }
            : {}),
        },
        body: line,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      return fail(UNAVAILABLE_MESSAGE);
    }
    if (response.status === 202) return;
    if (response.status === 401) return fail(UNAVAILABLE_MESSAGE);
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      return fail(`F5 Agent Bridge returned HTTP ${response.status}.`);
    }
    if (request.method === "initialize" && response.ok) {
      const version = (body as { result?: { protocolVersion?: unknown } }).result?.protocolVersion;
      if (typeof version === "string") negotiatedVersion = version;
    }
    if (isNotification) return;
    // HTTP-level errors (413, 404, 500) carry no JSON-RPC envelope or id.
    const isJsonRpc =
      body !== null &&
      typeof body === "object" &&
      (body as { jsonrpc?: unknown }).jsonrpc === "2.0";
    if (!isJsonRpc) return fail(`F5 Agent Bridge returned HTTP ${response.status}.`);
    write(body);
  };

  const dispatch = (raw: string) => {
    const line = raw.trim();
    if (line.length === 0) return;
    let request: JsonRpcRequest;
    try {
      const parsed: unknown = JSON.parse(line);
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        write(jsonRpcError(null, -32600, "Send one JSON-RPC message per line."));
        return;
      }
      request = parsed as JsonRpcRequest;
    } catch {
      write(jsonRpcError(null, -32700, "Parse error."));
      return;
    }
    // Requests run concurrently: a long wait_for_submission must not block others.
    const task = forward(request, line).catch(() => {
      if (request.id !== undefined)
        write(jsonRpcError(request.id, AGENT_BRIDGE_UNAVAILABLE_CODE, UNAVAILABLE_MESSAGE));
    });
    pending.add(task);
    void task.finally(() => pending.delete(task));
  };
  // MCP messages end only at LF; Unicode separators belong to the JSON payload.
  const lines = new Utf8Lines();
  try {
    for await (const chunk of options.input) {
      for (const line of lines.push(chunk as Buffer | string)) dispatch(line);
    }
    for (const line of lines.finish()) dispatch(line);
  } finally {
    await Promise.allSettled(pending);
  }
}
