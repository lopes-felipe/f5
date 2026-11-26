import { closeProbeProcess } from "./McpProbeProcess.ts";
import { resolveInvocation } from "../spawn/resolveCommand.ts";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { homedir } from "node:os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { ReadBuffer, serializeMessage } from "@modelcontextprotocol/sdk/shared/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import type {
  McpProbeServerRequest,
  McpProbeServerResult,
  McpToolSummary,
} from "@t3tools/contracts";
import { summarizeMcpTools } from "@t3tools/shared/mcpTools";
import {
  describeMcpInterpolationSkip,
  interpolateMcpServers,
} from "@t3tools/shared/mcpInterpolation";
import { mcpBearerRedactionValues, mcpRemoteHeaders } from "@t3tools/shared/mcpTranslation";
import { isMcpCredentialKey, createMcpDiagnosticsSanitizer } from "@t3tools/shared/mcpDiagnostics";
import { Data, Effect } from "effect";
import { resolvedMcpSecretsIn } from "./mcpResolvedSecrets.ts";

/** The SDK's stdio transport does not own a process group. Probes must also reap descendants. */
export class ProbeStdioTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: NonNullable<Transport["onmessage"]>;
  protocolVersion?: string;
  private child?: ChildProcessWithoutNullStreams;
  private closing?: Promise<void>;
  private stderr = Buffer.alloc(0);
  private readonly stderrLimit: number;
  private readonly maxPendingBytes: number;
  constructor(
    private readonly command: string,
    private readonly args: string[],
    private readonly env: NodeJS.ProcessEnv,
    private readonly cwd: string,
    /** The MCP hub keeps a larger stderr ring and allows larger messages than a probe. */
    options: { readonly stderrLimit?: number; readonly maxPendingBytes?: number } = {},
  ) {
    this.stderrLimit = options.stderrLimit ?? 4096;
    this.maxPendingBytes = options.maxPendingBytes ?? 2 * 1024 * 1024;
  }
  get pid(): number | undefined {
    return this.child?.pid;
  }
  get stderrTail() {
    return this.stderr.toString("utf8");
  }
  setProtocolVersion(version: string) {
    this.protocolVersion = version;
  }
  async start(): Promise<void> {
    if (this.child || this.closing) throw new Error("Probe transport already started or closed.");
    // On Windows, `npx`, `pnpm dlx` and other npm commands are .cmd shims that
    // `spawn` cannot run without a shell; resolve them like provider binaries.
    const invocation =
      process.platform === "win32"
        ? await resolveInvocation(this.command, this.args, this.env, { cwd: this.cwd }).catch(
            () => ({ file: this.command, args: this.args }),
          )
        : { file: this.command, args: this.args };
    if (this.child || this.closing) throw new Error("Probe transport already started or closed.");
    const child = spawn(invocation.file, [...invocation.args], {
      env: this.env,
      cwd: this.cwd,
      detached: process.platform !== "win32",
      stdio: "pipe",
      shell: false,
      windowsHide: true,
    });
    this.child = child;
    const buffer = new ReadBuffer();
    let pendingBytes = 0;
    child.stderr.on("data", (chunk: Buffer) => {
      this.stderr = Buffer.concat([this.stderr, chunk.subarray(-this.stderrLimit)]).subarray(
        -this.stderrLimit,
      );
    });
    child.stdout.on("data", (chunk: Buffer) => {
      pendingBytes += chunk.length;
      if (pendingBytes > this.maxPendingBytes) {
        this.onerror?.(
          new Error(`MCP message exceeds ${Math.round(this.maxPendingBytes / 1024 / 1024)} MiB.`),
        );
        void this.close();
        return;
      }
      buffer.append(chunk);
      try {
        let message: JSONRPCMessage | null;
        while ((message = buffer.readMessage()) !== null) {
          pendingBytes = 0;
          this.onmessage?.(message);
        }
      } catch (error) {
        this.onerror?.(error instanceof Error ? error : new Error("Invalid MCP response."));
        void this.close();
      }
    });
    child.stdin.on("error", (error) => this.onerror?.(error));
    child.on("close", () => this.onclose?.());
    return new Promise((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", (error) => {
        this.onerror?.(error);
        reject(error);
      });
    });
  }
  send(message: JSONRPCMessage): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.child || this.closing) {
        reject(new Error("Probe transport is closed."));
        return;
      }
      this.child.stdin.write(serializeMessage(message), (error) =>
        error ? reject(error) : resolve(),
      );
    });
  }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closing = (async () => {
      const child = this.child;
      if (!child) return;
      await closeProbeProcess(child, this.env);
      child.stdin.destroy();
      child.stdout.destroy();
      child.stderr.destroy();
      this.onclose?.();
    })();
    return this.closing;
  }
}

class McpProbeError extends Data.TaggedError("McpProbeError")<{
  message: string;
  authRequired: boolean;
}> {}
const active = new Set<string>();
const MAX_CONCURRENT_PROBES = 4;
export function probeMcpServer(
  input: McpProbeServerRequest,
  execution: {
    environment: NodeJS.ProcessEnv;
    cwd?: string | undefined;
    identity?: string | undefined;
  },
): Effect.Effect<McpProbeServerResult> {
  const start = Date.now();
  const key = JSON.stringify([
    input.instanceId ?? execution.identity ?? "default",
    input.serverName.trim().toLowerCase(),
  ]);
  const interpolation = interpolateMcpServers(
    { [input.serverName]: input.server },
    execution.environment,
  );
  const unresolved = interpolation.skipped[0];
  const server = interpolation.servers[input.serverName] ?? input.server;
  const sanitizer = createMcpDiagnosticsSanitizer({ [input.serverName]: server }, [
    ...mcpBearerRedactionValues(server, execution.environment),
    // Stored secrets resolved into arguments or the URL, which a server may echo back.
    ...resolvedMcpSecretsIn(JSON.stringify([server.type === "stdio" ? server.args : server.url])),
    ...Object.entries(execution.environment).flatMap(([name, value]) =>
      value && isMcpCredentialKey(name) ? [value] : [],
    ),
  ]);
  const empty = {
    tools: [] as McpToolSummary[],
    toolsTruncated: false,
    resourceCount: 0,
    promptCount: 0,
    authRequired: false,
  };
  return Effect.suspend<McpProbeServerResult, never, never>(() => {
    if (unresolved)
      return Effect.succeed({
        ...empty,
        ok: false,
        durationMs: Date.now() - start,
        error: `This server ${describeMcpInterpolationSkip(unresolved)}.`,
      });
    if (active.has(key) || active.size >= MAX_CONCURRENT_PROBES)
      return Effect.succeed({
        ...empty,
        ok: false,
        durationMs: Date.now() - start,
        error: active.has(key)
          ? "This server is already being tested."
          : `Too many tests are running (limit ${MAX_CONCURRENT_PROBES}). Wait for one to finish and try again.`,
      });
    return Effect.scoped(
      Effect.gen(function* () {
        yield* Effect.acquireRelease(
          Effect.sync(() => active.add(key)),
          () =>
            Effect.sync(() => {
              active.delete(key);
            }),
        );
        let transport: Transport;
        let protocolVersion: string | undefined;
        const client = new Client(
          { name: "f5-connection-test", version: "1.0.0" },
          { capabilities: {} },
        );
        const controller = new AbortController();
        // The same precedence as every provider: a literal Authorization header wins.
        const headers = new Headers(
          server.type === "stdio" ? undefined : mcpRemoteHeaders(server, execution.environment),
        );
        if (server.type === "stdio") {
          transport = new ProbeStdioTransport(
            server.command,
            [...(server.args ?? [])],
            { ...execution.environment, ...server.env },
            server.cwd ?? execution.cwd ?? execution.environment.HOME ?? homedir(),
          );
        } else {
          const options = {
            requestInit: { headers, signal: controller.signal },
            fetch: async (url: string | URL, init?: RequestInit) =>
              fetch(url, {
                ...init,
                signal: AbortSignal.any([
                  controller.signal,
                  ...(init?.signal ? [init.signal] : []),
                ]),
              }),
          };
          transport =
            server.type === "sse"
              ? (new SSEClientTransport(new URL(server.url), options) as Transport)
              : (new StreamableHTTPClientTransport(new URL(server.url), options) as Transport);
        }
        const setVersion = transport.setProtocolVersion?.bind(transport);
        transport.setProtocolVersion = (version) => {
          protocolVersion = version;
          setVersion?.(version);
        };
        yield* Effect.acquireRelease(Effect.void, () =>
          Effect.promise(async () => {
            controller.abort();
            await Promise.allSettled([client.close(), transport.close()]);
          }),
        );
        const run = Effect.tryPromise({
          try: async (signal) => {
            signal.addEventListener("abort", () => controller.abort(), { once: true });
            await client.connect(transport, {
              timeout: Math.min((server.startupTimeoutSec ?? 20) * 1000, 60_000),
              signal,
            });
            const capabilities = client.getServerCapabilities();
            let tools: McpToolSummary[] = [],
              toolsTruncated = false,
              resourceCount = 0,
              promptCount = 0;
            const pages = async (kind: "tools" | "resources" | "prompts") => {
              let cursor: string | undefined;
              const seen = new Set<string>();
              for (let page = 0; page < 5; page++) {
                if (signal.aborted) throw new Error("Probe cancelled.");
                const params = cursor ? { cursor } : {};
                const options = { timeout: 10_000, signal };
                if (kind === "tools") {
                  const result = await client.listTools(params, options);
                  const remaining = 200 - tools.length;
                  tools.push(...summarizeMcpTools(result.tools.slice(0, remaining)));
                  cursor = result.nextCursor;
                  if (result.tools.length > remaining || (tools.length >= 200 && cursor)) {
                    toolsTruncated = true;
                    return;
                  }
                } else if (kind === "resources") {
                  const result = await client.listResources(params, options);
                  resourceCount += Math.min(result.resources.length, 1000);
                  cursor = result.nextCursor;
                } else {
                  const result = await client.listPrompts(params, options);
                  promptCount += Math.min(result.prompts.length, 1000);
                  cursor = result.nextCursor;
                }
                if (!cursor) return;
                if (seen.has(cursor))
                  throw new Error(`Repeated ${kind} cursor; results are incomplete.`);
                seen.add(cursor);
              }
              if (kind === "tools") toolsTruncated = true;
              else throw new Error(`${kind} listing exceeded five pages; results are incomplete.`);
            };
            if (capabilities?.tools) await pages("tools");
            if (capabilities?.resources) await pages("resources");
            if (capabilities?.prompts) await pages("prompts");
            const info = client.getServerVersion();
            return {
              ok: true,
              tools,
              toolsTruncated,
              resourceCount,
              promptCount,
              authRequired: false,
              ...(info
                ? {
                    serverInfo: {
                      name: sanitizer.text(info.name).slice(0, 300),
                      version: sanitizer.text(info.version).slice(0, 128),
                    },
                  }
                : {}),
              ...(protocolVersion ? { protocolVersion } : {}),
            };
          },
          catch: (error) =>
            new McpProbeError({
              message: error instanceof Error ? error.message : "Connection test failed.",
              authRequired:
                (error instanceof Error && error.name === "UnauthorizedError") ||
                !!(error && typeof error === "object" && "code" in error && error.code === 401) ||
                /\b401\b|unauthorized/i.test(error instanceof Error ? error.message : ""),
            }),
        }).pipe(Effect.timeout("60 seconds"));
        const result = yield* run.pipe(
          Effect.catch((error) =>
            Effect.succeed({
              ...empty,
              ok: false,
              authRequired: error instanceof McpProbeError && error.authRequired,
              error: sanitizer.text(
                error instanceof Error ? error.message : "Connection test failed.",
              ),
            }),
          ),
        );
        return {
          ...result,
          durationMs: Date.now() - start,
          tools: result.tools.map((tool) => ({
            ...tool,
            name: sanitizer.text(tool.name).slice(0, 128),
            ...(tool.description
              ? { description: sanitizer.text(tool.description).slice(0, 300) }
              : {}),
          })),
          ...(transport instanceof ProbeStdioTransport && transport.stderrTail
            ? { stderrTail: sanitizer.text(transport.stderrTail).slice(-4096) }
            : {}),
        };
      }),
    ).pipe(Effect.map((result) => ({ ...result, durationMs: Date.now() - start })));
  });
}
