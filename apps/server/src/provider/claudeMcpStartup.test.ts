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

it("delivers servers at launch in initialize mode, then names them before admitting a prompt", async () => {
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
      options: { ...options, mcpServersDelivery: "initialize" },
      prompt: (async function* () {
        yield message;
      })(),
    },
    (input) => {
      prompt = input.prompt;
      // The SDK keeps these off argv itself, so launch gets every server.
      expect(input.options.mcpServers).toBe(servers);
      return runtime;
    },
  );
  const reading = (async () => {
    for await (const entry of prompt) consumed.push(entry);
  })();
  // Claude removes a launch server in place only after a call has named it.
  await vi.waitFor(() => expect(setMcpServers).toHaveBeenCalledWith(servers));
  expect(consumed).toEqual([]);
  finish();
  expect(await started).toBe(runtime);
  await reading;
  expect(consumed).toEqual([message]);
});

it("does not block an initialize-mode session when the ownership claim fails", async () => {
  const runtime = {
    initializationResult: async () => ({}),
    setMcpServers: vi.fn(async () => {
      throw new Error("refused");
    }),
    close: vi.fn(),
  };
  const input = {
    options: { ...options, mcpServersDelivery: "initialize" as const },
    prompt: (async function* () {
      yield message;
    })(),
  };
  expect(await createClaudeQueryWithPrivateMcp(input, () => runtime)).toBe(runtime);
  expect(runtime.close).not.toHaveBeenCalled();
});

it("skips the control call in initialize mode when only in-process servers launch", async () => {
  const runtime = { initializationResult: vi.fn(), setMcpServers: vi.fn(), close: vi.fn() };
  const input = {
    options: {
      mcpServersDelivery: "initialize" as const,
      mcpServers: { f5_thread: { type: "sdk", name: "f5_thread", instance: {} } },
    } as unknown as Options,
    prompt: (async function* () {
      yield message;
    })(),
  };
  const createQuery = vi.fn(() => runtime);
  expect(await createClaudeQueryWithPrivateMcp(input, createQuery)).toBe(runtime);
  expect(createQuery).toHaveBeenCalledExactlyOnceWith(input);
  expect(runtime.setMcpServers).not.toHaveBeenCalled();
});
