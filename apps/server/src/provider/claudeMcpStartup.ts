import type { McpServerConfig, Options, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";

interface QueryInput {
  readonly prompt: AsyncIterable<SDKUserMessage>;
  readonly options: Options;
}
interface PrivateMcpRuntime {
  readonly initializationResult?: () => Promise<unknown>;
  readonly setMcpServers?: (servers: Record<string, McpServerConfig>) => Promise<unknown>;
  readonly close: () => void;
}

/**
 * SDK startup configs become --mcp-config JSON in argv. Send header/env-bearing
 * servers over the existing control channel instead, before admitting a prompt.
 * Keep the original options intact so every recovery launch takes this path too.
 */
export async function createClaudeQueryWithPrivateMcp<Q extends PrivateMcpRuntime>(
  input: QueryInput,
  createQuery: (input: QueryInput) => Q,
  options: { readonly signal?: AbortSignal; readonly timeoutMs?: number } = {},
): Promise<Q> {
  const servers = input.options.mcpServers;
  const hasPrivateValues = (server: McpServerConfig) =>
    ("headers" in server && Object.values(server.headers ?? {}).some(Boolean)) ||
    ("env" in server && Object.values(server.env ?? {}).some(Boolean));
  if (!servers || !Object.values(servers).some(hasPrivateValues)) return createQuery(input);
  if (options.signal?.aborted) throw new Error("Claude MCP startup was canceled.");

  const startup = Object.fromEntries(
    Object.entries(servers).filter(([, server]) => !hasPrivateValues(server)),
  );
  const otherOptions = { ...input.options };
  delete otherOptions.mcpServers;
  let release!: (admitted: boolean) => void;
  const admitted = new Promise<boolean>((resolve) => {
    release = resolve;
  });
  const prompt = (async function* () {
    if (await admitted) yield* input.prompt;
  })();
  const runtime = createQuery({
    prompt,
    options: { ...otherOptions, ...(Object.keys(startup).length ? { mcpServers: startup } : {}) },
  });
  let stopped = false;
  const close = () => {
    release(false);
    if (!stopped) {
      stopped = true;
      runtime.close();
    }
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort: (() => void) | undefined;
  try {
    const canceled = new Promise<never>((_, reject) => {
      abort = () => {
        close();
        reject(new Error("MCP startup canceled"));
      };
      options.signal?.addEventListener("abort", abort, { once: true });
      if (options.signal?.aborted) abort();
      timer = setTimeout(() => {
        close();
        reject(new Error("MCP startup timed out"));
      }, options.timeoutMs ?? 45_000);
    });
    await Promise.race([
      (async () => {
        if (!runtime.setMcpServers) throw new Error("The runtime has no private MCP transport");
        await runtime.initializationResult?.();
        if (stopped) return;
        await runtime.setMcpServers(servers);
      })(),
      canceled,
    ]);
    if (stopped) throw new Error("MCP startup canceled");
    release(true);
    return runtime;
  } catch {
    close();
    // Provider errors can echo the configuration. Never expose that payload.
    throw new Error(
      "Claude MCP configuration could not be installed securely. No message was sent.",
    );
  } finally {
    clearTimeout(timer);
    if (abort) options.signal?.removeEventListener("abort", abort);
  }
}
