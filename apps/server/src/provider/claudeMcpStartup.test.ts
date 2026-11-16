import type { Options, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { expect, it, vi } from "vitest";
import { createClaudeQueryWithPrivateMcp } from "./claudeMcpStartup.ts";

const servers = {
  privateHttp: {
    type: "http",
    url: "https://example.invalid/mcp",
    headers: { Authorization: "Bearer private-header-fixture" },
  },
  privateStdio: { type: "stdio", command: "node", env: { ACCESS_KEY: "private-env-fixture" } },
  publicStdio: { type: "stdio", command: "node" },
} satisfies NonNullable<Options["mcpServers"]>;
const options = { mcpServers: servers } satisfies Options;
const message: SDKUserMessage = {
  type: "user",
  session_id: "fixture",
  parent_tool_use_id: null,
  message: { role: "user", content: "test" },
};

it("keeps header and env values out of startup config and gates prompts until control configuration finishes", async () => {
  let finish!: () => void;
  let prompt!: AsyncIterable<SDKUserMessage>;
  const consumed: SDKUserMessage[] = [];
  const setMcpServers = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  const runtime = { initializationResult: async () => ({}), setMcpServers, close: vi.fn() };
  const started = createClaudeQueryWithPrivateMcp(
    {
      options,
      prompt: (async function* () {
        yield message;
      })(),
    },
    (input) => {
      prompt = input.prompt;
      expect(JSON.stringify(input.options)).not.toContain("private-header-fixture");
      expect(JSON.stringify(input.options)).not.toContain("private-env-fixture");
      expect(input.options.mcpServers).toEqual({ publicStdio: servers.publicStdio });
      return runtime;
    },
  );
  const reading = (async () => {
    for await (const entry of prompt) consumed.push(entry);
  })();
  await vi.waitFor(() => expect(setMcpServers).toHaveBeenCalledWith(servers));
  expect(consumed).toEqual([]);
  finish();
  expect(await started).toBe(runtime);
  await reading;
  expect(consumed).toEqual([message]);
  expect(options.mcpServers).toBe(servers);
});

it.each(["failure", "abort", "timeout"])(
  "closes an incomplete private MCP start without dispatch or secret-bearing errors (%s)",
  async (mode) => {
    const abort = new AbortController();
    const runtime = {
      initializationResult: async () => ({}),
      setMcpServers: vi.fn(async () => {
        if (mode === "failure") throw new Error("private-header-fixture");
        await new Promise(() => {});
      }),
      close: vi.fn(),
    };
    let prompt!: AsyncIterable<SDKUserMessage>;
    const started = createClaudeQueryWithPrivateMcp(
      {
        options,
        prompt: (async function* () {
          yield message;
        })(),
      },
      (input) => {
        prompt = input.prompt;
        return runtime;
      },
      { signal: abort.signal, timeoutMs: 50 },
    );
    const outcome = started.catch((error: unknown) => error);
    await vi.waitFor(() => expect(runtime.setMcpServers).toHaveBeenCalled(), { interval: 1 });
    if (mode === "abort") abort.abort();
    const error = await outcome;
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).toContain("No message was sent");
    expect(String(error)).not.toContain("private-header-fixture");
    expect(runtime.close).toHaveBeenCalledTimes(1);
    const consumed: SDKUserMessage[] = [];
    for await (const entry of prompt) consumed.push(entry);
    expect(consumed).toEqual([]);
  },
);
