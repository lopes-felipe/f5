import http from "node:http";
import type { AddressInfo } from "node:net";
import { PassThrough } from "node:stream";

import { describe, expect, it } from "vitest";

import {
  MCP_SESSION_UNAVAILABLE_CODE,
  mcpSessionStdioLaunch,
  runMcpSessionStdio,
  type McpSessionPost,
} from "./sessionStdioShim.ts";

const ENV = { F5_MCP_URL: "http://127.0.0.1:1/mcp/interaction", F5_MCP_TOKEN: "token-1" };

function harness(post: McpSessionPost, env: NodeJS.ProcessEnv = ENV) {
  const input = new PassThrough();
  const output = new PassThrough();
  const lines: unknown[] = [];
  let buffered = "";
  output.on("data", (chunk: Buffer) => {
    buffered += chunk.toString("utf8");
    const parts = buffered.split("\n");
    buffered = parts.pop() ?? "";
    for (const part of parts) if (part) lines.push(JSON.parse(part));
  });
  const done = runMcpSessionStdio({ input, output, env, post });
  return { input, lines, done };
}

describe("runMcpSessionStdio", () => {
  it("forwards each line with the session token and writes the reply", async () => {
    const posted: Array<{ url: string; token: string; body: string }> = [];
    const { input, lines, done } = harness(async ({ url, token, body }) => {
      posted.push({ url, token, body });
      const request = JSON.parse(body) as { id?: number };
      return request.id === undefined
        ? { status: 202, body: "" }
        : { status: 200, body: JSON.stringify({ jsonrpc: "2.0", id: request.id, result: {} }) };
    });
    input.write('{"jsonrpc":"2.0","id":1,"method":"tools/list"}\n');
    input.end('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
    await done;
    expect(posted.map((entry) => [entry.url, entry.token])).toEqual([
      [ENV.F5_MCP_URL, "token-1"],
      [ENV.F5_MCP_URL, "token-1"],
    ]);
    expect(lines).toEqual([{ jsonrpc: "2.0", id: 1, result: {} }]);
  });

  it("answers with a clear error when F5 is unreachable or not configured", async () => {
    const unreachable = harness(async () => {
      throw new Error("ECONNREFUSED");
    });
    unreachable.input.end('{"jsonrpc":"2.0","id":7,"method":"tools/list"}\n');
    await unreachable.done;
    expect(unreachable.lines).toMatchObject([
      { id: 7, error: { code: MCP_SESSION_UNAVAILABLE_CODE } },
    ]);

    const unconfigured = harness(async () => ({ status: 200, body: "{}" }), {});
    unconfigured.input.end('{"jsonrpc":"2.0","id":8,"method":"initialize"}\n');
    await unconfigured.done;
    expect(unconfigured.lines).toMatchObject([
      { id: 8, error: { code: MCP_SESSION_UNAVAILABLE_CODE } },
    ]);
  });

  it("reports HTTP errors without a JSON-RPC envelope and rejects malformed lines", async () => {
    const { input, lines, done } = harness(async () => ({ status: 500, body: "{}" }));
    input.write('{"jsonrpc":"2.0","id":2,"method":"tools/call"}\n');
    input.end("not json\n");
    await done;
    expect(lines).toContainEqual(expect.objectContaining({ id: 2 }));
    expect(lines).toContainEqual(
      expect.objectContaining({ id: null, error: expect.objectContaining({ code: -32700 }) }),
    );
  });

  it("drops in-flight requests when the agent closes stdin", async () => {
    let aborted = false;
    const { input, lines, done } = harness(
      ({ signal }) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => {
            aborted = true;
            reject(new Error("aborted"));
          });
        }),
    );
    input.end('{"jsonrpc":"2.0","id":3,"method":"tools/call"}\n');
    await done;
    expect(aborted).toBe(true);
    expect(lines).toEqual([]);
  });

  it("waits on a slow reply over node:http without a deadline", async () => {
    const server = http.createServer((request, response) => {
      let body = "";
      request.on("data", (chunk: Buffer) => (body += chunk.toString("utf8")));
      request.on("end", () => {
        expect(request.headers.authorization).toBe("Bearer token-2");
        const { id } = JSON.parse(body) as { id: number };
        setTimeout(() => {
          response.writeHead(200, { "content-type": "application/json" });
          response.end(JSON.stringify({ jsonrpc: "2.0", id, result: { ok: true } }));
        }, 50);
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const { port } = server.address() as AddressInfo;
      const input = new PassThrough();
      const output = new PassThrough();
      const chunks: string[] = [];
      output.on("data", (chunk: Buffer) => chunks.push(chunk.toString("utf8")));
      const done = runMcpSessionStdio({
        input,
        output,
        env: { F5_MCP_URL: `http://127.0.0.1:${port}/mcp/interaction`, F5_MCP_TOKEN: "token-2" },
      });
      input.write('{"jsonrpc":"2.0","id":9,"method":"tools/call"}\n');
      await expect
        .poll(() => chunks.join(""))
        .toBe(`${JSON.stringify({ jsonrpc: "2.0", id: 9, result: { ok: true } })}\n`);
      input.end();
      await done;
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

describe("mcpSessionStdioLaunch", () => {
  it("runs the shim with this process's runtime and entry", () => {
    expect(
      mcpSessionStdioLaunch({
        env: { ELECTRON_RUN_AS_NODE: "1" },
        execPath: "/Applications/F5.app/Contents/MacOS/F5",
        execArgv: [],
        entry: "/Applications/F5.app/Contents/Resources/server/index.mjs",
      }),
    ).toEqual({
      command: "/Applications/F5.app/Contents/MacOS/F5",
      args: ["/Applications/F5.app/Contents/Resources/server/index.mjs", "mcp-session-stdio"],
      env: { F5_DESKTOP_COMPUTER_HOST: "", ELECTRON_RUN_AS_NODE: "1" },
    });
    expect(
      mcpSessionStdioLaunch({ env: {}, execPath: "/usr/bin/node", execArgv: [], entry: undefined }),
    ).toBeUndefined();
  });
});
