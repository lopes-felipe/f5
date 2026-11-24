/**
 * `t3 mcp-session-stdio`: serves one of F5's per-session MCP catalogs to an
 * agent that only speaks stdio MCP. Each stdin JSON-RPC line is POSTed to
 * `F5_MCP_URL` with `F5_MCP_TOKEN` as the bearer token, and each reply is
 * written to stdout.
 *
 * Requests run concurrently and have no deadline: `ask_user_question` waits
 * for the user. When stdin closes, in-flight requests are dropped, which tells
 * F5 to stop waiting for them.
 *
 * @module mcp/sessionStdioShim
 */
import http from "node:http";
import type { Readable, Writable } from "node:stream";

import { Utf8Lines } from "@t3tools/shared/utf8Lines";

import { jsonRpcError, type JsonRpcRequest } from "./jsonRpcHttp.ts";

export const MCP_SESSION_URL_ENV = "F5_MCP_URL";
export const MCP_SESSION_TOKEN_ENV = "F5_MCP_TOKEN";
/** JSON-RPC error for "F5 is not reachable". */
export const MCP_SESSION_UNAVAILABLE_CODE = -32002;
const UNAVAILABLE_MESSAGE = "F5 is not reachable. The F5 session that started this tool ended.";

export interface McpSessionPostResult {
  readonly status: number;
  readonly body: string;
}

export type McpSessionPost = (input: {
  readonly url: string;
  readonly token: string;
  readonly body: string;
  readonly signal: AbortSignal;
}) => Promise<McpSessionPostResult>;

export interface McpSessionStdioOptions {
  readonly input: Readable;
  readonly output: Writable;
  readonly env?: NodeJS.ProcessEnv;
  readonly post?: McpSessionPost;
}

/** node:http, not fetch: fetch gives up on a reply that takes more than five minutes. */
const postWithNodeHttp: McpSessionPost = ({ url, token, body, signal }) =>
  new Promise((resolve, reject) => {
    const request = http.request(
      url,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          accept: "application/json",
          "content-length": Buffer.byteLength(body),
        },
        signal,
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () =>
          resolve({
            status: response.statusCode ?? 0,
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
        response.on("error", reject);
      },
    );
    request.on("error", reject);
    request.end(body);
  });

export async function runMcpSessionStdio(options: McpSessionStdioOptions): Promise<void> {
  const env = options.env ?? process.env;
  const url = env[MCP_SESSION_URL_ENV]?.trim();
  const token = env[MCP_SESSION_TOKEN_ENV]?.trim();
  const post = options.post ?? postWithNodeHttp;
  const closed = new AbortController();
  const pending = new Set<Promise<void>>();

  const write = (message: unknown) => {
    options.output.write(`${JSON.stringify(message)}\n`);
  };

  const forward = async (request: JsonRpcRequest, line: string): Promise<void> => {
    const isNotification = request.id === undefined;
    const fail = (message: string) => {
      if (!isNotification) write(jsonRpcError(request.id, MCP_SESSION_UNAVAILABLE_CODE, message));
    };
    if (!url || !token) return fail(UNAVAILABLE_MESSAGE);
    let response: McpSessionPostResult;
    try {
      response = await post({ url, token, body: line, signal: closed.signal });
    } catch {
      if (closed.signal.aborted) return;
      return fail(UNAVAILABLE_MESSAGE);
    }
    if (response.status === 202 || isNotification) return;
    if (response.status === 401) return fail(UNAVAILABLE_MESSAGE);
    let body: unknown;
    try {
      body = JSON.parse(response.body);
    } catch {
      return fail(`F5 returned HTTP ${response.status}.`);
    }
    // HTTP-level errors (413, 404, 500) carry no JSON-RPC envelope or id.
    const isJsonRpc =
      body !== null &&
      typeof body === "object" &&
      !Array.isArray(body) &&
      (body as { jsonrpc?: unknown }).jsonrpc === "2.0";
    if (!isJsonRpc) return fail(`F5 returned HTTP ${response.status}.`);
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
    // Responses to requests F5 never sends (no server-to-client requests) are dropped.
    if (request.method === undefined) return;
    const task = forward(request, line).catch(() => {
      if (request.id !== undefined)
        write(jsonRpcError(request.id, MCP_SESSION_UNAVAILABLE_CODE, UNAVAILABLE_MESSAGE));
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
    // The agent closed stdin: nobody is left to read the replies.
    closed.abort();
    await Promise.allSettled(pending);
  }
}

export interface McpSessionStdioLaunch {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly env: Readonly<Record<string, string>>;
}

/**
 * Runs the shim with the same runtime and entry as this server process. Inside
 * the desktop app that is `ELECTRON_RUN_AS_NODE=1 <F5 executable> <entry>`.
 * Undefined when the entry is unknown.
 */
export function mcpSessionStdioLaunch(input?: {
  readonly env?: NodeJS.ProcessEnv;
  readonly execPath?: string;
  readonly execArgv?: ReadonlyArray<string>;
  readonly entry?: string | undefined;
}): McpSessionStdioLaunch | undefined {
  const env = input?.env ?? process.env;
  const entry = input && "entry" in input ? input.entry : process.argv[1];
  if (!entry) return undefined;
  return {
    command: input?.execPath ?? process.execPath,
    args: [...(input?.execArgv ?? process.execArgv), entry, "mcp-session-stdio"],
    env: {
      // The shim is not a VM guest backend and must not claim its desktop channel.
      F5_DESKTOP_COMPUTER_HOST: "",
      ...(env.ELECTRON_RUN_AS_NODE === "1" ? { ELECTRON_RUN_AS_NODE: "1" } : {}),
    },
  };
}
