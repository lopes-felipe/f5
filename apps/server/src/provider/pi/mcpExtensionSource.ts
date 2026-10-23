/**
 * Do not import F5 modules from the string body. The Pi process resolves
 * `@earendil-works/pi-coding-agent` and `typebox` from the user's pi install.
 */
import {
  F5_PI_READ_ONLY_ENV,
  F5_PI_MCP_URL_ENV,
  F5_PI_MCP_BEARER_ENV,
  F5_PI_RUNTIME_MODE_ENV,
  F5_PI_MCP_EXTENSION_PATH_ENV,
} from "./PiEnvironment.ts";
const F5_ORCHESTRATION_INSTRUCTIONS = `F5's MCP tools are scoped to this thread. Use thread_status to inspect it and thread_settle only when work is complete. PR watch tools create continuing work only when requested. Use html_preview to validate a visual before html_render publishes it in the thread. Discover available tools from the live catalog and follow their input schemas.`;

export const PI_F5_MCP_EXTENSION_FILENAME = "pi-f5-mcp-extension.ts";

/**
 * Pi tools whose confirmations the bridge raises as file-change approvals.
 * Auto-accept edits skips them; the adapter keys the approval kind off them.
 */
export const PI_FILE_CHANGE_TOOLS = ["edit", "write"] as const;

export const PI_F5_MCP_EXTENSION_SOURCE = `\
import { stripFrontmatter, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import { Type } from "typebox";

const READ_ONLY_ENV = ${JSON.stringify(F5_PI_READ_ONLY_ENV)};
const URL_ENV = ${JSON.stringify(F5_PI_MCP_URL_ENV)};
const TOKEN_ENV = ${JSON.stringify(F5_PI_MCP_BEARER_ENV)};
const RUNTIME_MODE_ENV = ${JSON.stringify(F5_PI_RUNTIME_MODE_ENV)};
const EXTENSION_PATH_ENV = ${JSON.stringify(F5_PI_MCP_EXTENSION_PATH_ENV)};
const ORCHESTRATION_INSTRUCTIONS = ${JSON.stringify(F5_ORCHESTRATION_INSTRUCTIONS.trim())};
const PROTOCOL = "2025-06-18";
const READ_ONLY_TOOLS = new Set(["read", "grep", "find", "ls"]);
const MAX_HTTP_BYTES = 16 * 1024 * 1024;
const FILE_CHANGE_TOOLS = new Set(${JSON.stringify(PI_FILE_CHANGE_TOOLS)});

type RuntimeMode = "approval-required" | "auto-accept-edits" | "auto" | "full-access";

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

type JsonRpcResponse = {
  readonly id?: number | string;
  readonly result?: JsonValue;
  readonly error?: { readonly message?: string };
};

type McpTool = {
  readonly name: string;
  readonly description?: string;
  readonly inputSchema?: Record<string, unknown>;
  readonly annotations?: { readonly readOnlyHint?: boolean };
  readonly outputSchema?: Record<string, unknown>;
};

function env(name: string): string | undefined {
  const value = process.env[name];
  return value && value.length > 0 ? value : undefined;
}

function runtimeMode(): RuntimeMode {
  const value = env(RUNTIME_MODE_ENV);
  return value === "approval-required" ||
    value === "auto-accept-edits" ||
    value === "auto" ||
    value === "full-access"
    ? value
    : "approval-required";
}

function toolInputSummary(input: unknown): string {
  try {
    return JSON.stringify(input, null, 2).slice(0, 4_000);
  } catch {
    return String(input).slice(0, 4_000);
  }
}

function parseMcpJson(body: string): JsonRpcResponse {
  try { return JSON.parse(body) as JsonRpcResponse; }
  catch { throw new Error("F5 MCP returned invalid JSON."); }
}

function parseSseOrJson(body: string, contentType: string): JsonRpcResponse {
  if (contentType.includes("text/event-stream")) {
    for (const line of body.split("\\n")) {
      const trimmed = line.startsWith("data:") ? line.slice(5).trim() : "";
      if (trimmed.length === 0) continue;
      const parsed = parseMcpJson(trimmed);
      if (parsed.id !== undefined || parsed.result !== undefined || parsed.error !== undefined) {
        return parsed;
      }
    }
    throw new Error("MCP SSE response had no JSON-RPC payload.");
  }
  return parseMcpJson(body);
}

function jsonSchemaToTypebox(schema: Record<string, unknown> | undefined) {
  const unsafe = (Type as { Unsafe?: (value: unknown) => unknown }).Unsafe;
  if (typeof unsafe === "function" && schema !== undefined) {
    return unsafe(schema);
  }
  return Type.Object({}, { additionalProperties: true });
}

type ModelContent =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

function mcpModelContent(result: unknown): ModelContent[] {
  if (result === null || result === undefined) return [];
  if (typeof result !== "object") return [{ type: "text", text: String(result) }];
  const record = result as {
    readonly content?: ReadonlyArray<{
      readonly type?: string;
      readonly text?: string;
      readonly data?: string;
      readonly mimeType?: string;
    }>;
    readonly structuredContent?: unknown;
  };
  const content: ModelContent[] = [];
  if (Array.isArray(record.content)) {
    for (const part of record.content) {
      if (part?.type === "text" && typeof part.text === "string") {
        content.push({ type: "text", text: part.text });
      } else if (part?.type === "image" && typeof part.data === "string" && typeof part.mimeType === "string") {
        content.push({ type: "image", data: part.data, mimeType: part.mimeType });
      }
    }
  }
  // Structured output belongs to scripts. Only use it as model text when
  // the server supplied no model-facing blocks, matching Pi's native MCP tools.
  if (content.length === 0) {
    content.push({ type: "text", text: JSON.stringify(record.structuredContent ?? result) });
  }
  return content;
}

function mcpScriptResult(result: JsonValue | undefined) {
  if (typeof result !== "object" || result === null || Array.isArray(result)) return result;
  const { _meta: _ignored, ...scriptResult } = result;
  return scriptResult;
}

function mcpOutputSchema(tool: McpTool) {
  return jsonSchemaToTypebox({
    type: "object",
    properties: {
      content: { type: "array", items: { type: "object" } },
      ...(tool.outputSchema === undefined ? {} : { structuredContent: tool.outputSchema }),
      isError: { type: "boolean" },
      _meta: { type: "object" },
    },
    required: ["content"],
  });
}

function isMcpToolError(result: unknown): boolean {
  return (
    typeof result === "object" &&
    result !== null &&
    "isError" in result &&
    result.isError === true
  );
}

async function readSkill(path: string): Promise<string> {
  const file = await NodeFSP.open(path, "r");
  try {
    const maximum = 1024 * 1024;
    const bytes = Buffer.alloc(maximum + 1);
    let used = 0;
    while (used < bytes.length) {
      const result = await file.read(bytes, used, bytes.length - used, null);
      if (result.bytesRead === 0) break;
      used += result.bytesRead;
    }
    if (used > maximum) throw new Error("Pi skill exceeds its byte limit.");
    return bytes.subarray(0, used).toString("utf8");
  } finally { await file.close(); }
}

async function readBoundedResponse(response: Response): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const item = await reader.read();
      if (item.done) break;
      bytes += item.value.byteLength;
      if (bytes > MAX_HTTP_BYTES) throw new Error("F5 MCP response exceeds its byte limit.");
      chunks.push(item.value);
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
  const joined = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) { joined.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder("utf-8", { fatal: true }).decode(joined);
}

function createMcpClient(endpoint: string, token: string) {
  let nextId = 1;
  let sessionId: string | undefined;
  let protocol = PROTOCOL;
  let pendingRequests = 0;

  const headers = (): Record<string, string> => {
    const next: Record<string, string> = {
      accept: "application/json, text/event-stream",
      authorization: token.startsWith("Bearer ") ? token : \`Bearer \${token}\`,
      "content-type": "application/json",
      // Effect's HTTP MCP rejects post-initialize requests without this
      // (400). The worktree client in McpHttpServer tests sends the same
      // header; initialize itself does not require it.
      "mcp-protocol-version": protocol,
    };
    if (sessionId !== undefined) next["mcp-session-id"] = sessionId;
    return next;
  };

  const request = async (method: string, params?: unknown, signal?: AbortSignal) => {
    if (pendingRequests >= 8) throw new Error("F5 MCP has too many pending requests.");
    pendingRequests++;
    try {
    const id = nextId++;
    const response = await fetch(endpoint, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
      signal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(60_000)]),
    });
    const nextSession = response.headers.get("mcp-session-id");
    if (nextSession) sessionId = nextSession;
    const body = await readBoundedResponse(response);
    if (!response.ok) {
      throw new Error(\`MCP \${method} failed (\${response.status})\`);
    }
    if (body.length === 0) return undefined;
    const parsed = parseSseOrJson(body, response.headers.get("content-type") ?? "");
    if (parsed.error) {
      throw new Error(\`MCP \${method} returned an error\`);
    }
    return parsed.result;
    } finally { pendingRequests--; }
  };

  const notify = async (method: string, params?: unknown, signal?: AbortSignal) => {
    await fetch(endpoint, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ jsonrpc: "2.0", method, params }),
      signal,
    });
  };

  return {
    async connect(signal?: AbortSignal) {
      const initialized = await request(
        "initialize",
        {
          protocolVersion: PROTOCOL,
          capabilities: {},
          clientInfo: { name: "f5-pi-mcp", version: "1.0.0" },
        },
        signal,
      );
      if (initialized && typeof initialized === "object" && !Array.isArray(initialized)) {
        const agreed = initialized.protocolVersion;
        if (agreed === "2024-11-05" || agreed === "2025-03-26" || agreed === PROTOCOL) protocol = agreed;
        else if (agreed !== undefined) throw new Error("F5 MCP negotiated an unsupported protocol version.");
      }
      await notify("notifications/initialized", {}, signal).catch(() => undefined);
    },
    async listTools(signal?: AbortSignal) {
      const tools: McpTool[] = [];
      let cursor: string | undefined;
      const seenCursors = new Set<string>();
      do {
        const result = (await request(
          "tools/list",
          cursor === undefined ? {} : { cursor },
          signal,
        )) as { tools?: McpTool[]; nextCursor?: string } | undefined;
        const page = result?.tools ?? [];
        if (!Array.isArray(page) || tools.length + page.length > 2048) throw new Error("F5 MCP tool catalog exceeds its limit.");
        tools.push(...page);
        cursor = result?.nextCursor;
        if (cursor !== undefined && (typeof cursor !== "string" || seenCursors.has(cursor) || seenCursors.size >= 64)) throw new Error("F5 MCP tool pagination is invalid.");
        if (cursor) seenCursors.add(cursor);
      } while (cursor);
      return tools;
    },
    async callTool(name: string, args: Record<string, unknown>, signal?: AbortSignal) {
      return request("tools/call", { name, arguments: args }, signal);
    },
  };
}

export default async function f5McpExtension(pi: ExtensionAPI) {
  // Keep skill chips in the request. Pi expands only one leading /skill:
  // command, so use its own frontmatter loader for every selected chip here.
  pi.on("input", async (event, ctx) => {
    if (!event.text.includes("$")) return;
    const commands = pi.getCommands().filter((command) => command.source === "skill");
    const nativeSkill = /^\\/skill:([^ ]+)(?: |$)/.exec(event.text)?.[1];
    const seen = new Set<string>(nativeSkill === undefined ? [] : [nativeSkill]);
    const blocks: string[] = [];
    let skillBytes = 0;
    for (const match of event.text.matchAll(/(^|\\s)\\$([^\\s]+)(?=\\s|$)/g)) {
      const name = match[2];
      if (name === undefined || seen.has(name)) continue;
      const command = commands.find((candidate) => candidate.name === "skill:" + name);
      if (command === undefined) continue;
      seen.add(name);
      const path = command.sourceInfo.path;
      try {
        const body = stripFrontmatter(await readSkill(path)).trim();
        skillBytes += Buffer.byteLength(body, "utf8");
        if (blocks.length >= 32 || skillBytes > 2 * 1024 * 1024) throw new Error("Selected Pi skills exceed their byte limit.");
        blocks.push(
          \`<skill name="\${name}" location="\${path}">\\nReferences are relative to \${NodePath.dirname(path)}.\\n\\n\${body}\\n</skill>\`,
        );
      } catch {
        ctx.ui.notify(\`Could not load skill \${name} from \${path}.\`, "error");
      }
    }
    if (blocks.length === 0) return;
    return {
      action: "transform",
      text: event.text + "\\n\\n" + blocks.join("\\n\\n"),
      images: event.images,
    };
  });

  // Workaround for an upstream Pi context-budgeting bug: pi-ai reuses the
  // previous response's usage even when a fork's instructions/tools differ,
  // then reserves almost all remaining context for output. OpenRouter can
  // reject even a short conversation. Remove this cap when Pi accounts for
  // the current request prefix reliably (api/simple-options + utils/estimate).
  pi.on("before_provider_request", (event, ctx) => {
    if (ctx.model?.provider !== "openrouter") return;
    const payload = event.payload;
    if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return;
    const replacement = { ...payload } as Record<string, unknown>;
    let changed = false;
    for (const key of ["max_tokens", "max_completion_tokens"]) {
      const limit = replacement[key];
      if (typeof limit === "number" && Number.isFinite(limit) && limit > 32_768) {
        replacement[key] = 32_768;
        changed = true;
      }
    }
    if (changed) return replacement;
  });

  // Pi deliberately leaves permission policy to extensions. F5's injected
  // bridge uses Pi's public blocking tool hook so the shared runtime modes
  // keep their normal meaning without replacing or shadowing Pi's runtime.
  // Only Pi's own search is known to be read-only. An extension that replaces
  // it keeps the name, and cannot discover deferred tools either.
  const hasBuiltinToolSearch = () =>
    typeof pi.getAllTools === "function" &&
    pi.getAllTools().some((tool) => tool.name === "tool_search" && tool.sourceInfo?.path === "builtin:tool-search");

  const isBuiltinTool = (name: string) => typeof pi.getAllTools === "function" &&
    pi.getAllTools().some((tool) => tool.name === name &&
      typeof tool.sourceInfo?.path === "string" && tool.sourceInfo.path.startsWith("builtin:"));
  const readOnlyMcpTools = new Set<string>();
  const isReadOnlyMcpTool = (name: string) => {
    const extensionPath = env(EXTENSION_PATH_ENV);
    if (extensionPath === undefined || !readOnlyMcpTools.has(name) || typeof pi.getAllTools !== "function") return false;
    // A user extension may own the same name. Only our registered HTTP bridge
    // may inherit the canonical F5 server's read-only annotation.
    return pi.getAllTools().some((tool) => tool.name === name &&
      typeof tool.sourceInfo?.path === "string" &&
      NodePath.resolve(tool.sourceInfo.path) === NodePath.resolve(extensionPath));
  };

  pi.on("tool_call", async (event, ctx) => {
    const mode = runtimeMode();
    const safeRead = (event.toolName === "tool_search" ? hasBuiltinToolSearch() : (READ_ONLY_TOOLS.has(event.toolName) && isBuiltinTool(event.toolName))) || isReadOnlyMcpTool(event.toolName);
    // Read-only workflow restrictions precede even full-access mode. No modal
    // approval can grant a mutation to an unattended run.
    if (env(READ_ONLY_ENV) === "1") return safeRead ? undefined : { block: true, reason: "This F5 turn permits read-only tools only." };
    if (mode === "full-access" || safeRead) return;
    if (mode === "auto-accept-edits" && FILE_CHANGE_TOOLS.has(event.toolName) && isBuiltinTool(event.toolName)) {
      return;
    }
    const approved = await ctx.ui.confirm(
      \`Allow \${event.toolName}?\`,
      toolInputSummary(event.input),
      { signal: ctx.signal },
    );
    if (!approved) {
      return { block: true, reason: \`\${event.toolName} was declined in F5.\` };
    }
  });

  const endpoint = env(URL_ENV);
  const token = env(TOKEN_ENV);
  if (endpoint === undefined || token === undefined) {
    pi.on("session_start", async (_event, ctx) => {
      ctx.ui.notify(
        "f5 MCP unavailable: F5_PI_MCP_URL or F5_PI_MCP_BEARER_TOKEN is missing.",
        "warning",
      );
    });
    return;
  }

  // Tool exposure arrived with registerMcpServer in Pi 0.99. Keep the HTTP
  // bridge as the credential owner: mcp.json overrides native registrations.
  const supportsExposure = "registerMcpServer" in pi && typeof pi.registerMcpServer === "function";
  const directTools = new Set(["thread_status"]);
  let deferOptionalTools = supportsExposure;
  let catalog: ReadonlyArray<McpTool> = [];

  const client = createMcpClient(endpoint, token);
  let started: Promise<void> | undefined;

  const registerTools = () => {
    // Preserve the canonical public names for saved loadouts and tool selectors.
    const prefix = "mcp__f5__";
    readOnlyMcpTools.clear();
    for (const tool of catalog) {
      const name = tool.name;
        if (tool.annotations?.readOnlyHint === true) readOnlyMcpTools.add(\`\${prefix}\${name}\`);
        const exposure = deferOptionalTools && !directTools.has(name) ? "deferred" : "direct";
        pi.registerTool({
          name: \`\${prefix}\${name}\`,
          label: name,
          description: tool.description ?? name,
          parameters: jsonSchemaToTypebox(tool.inputSchema),
          ...(supportsExposure ? { outputSchema: mcpOutputSchema(tool) } : {}),
          ...(supportsExposure ? { exposure } : {}),
          async execute(_toolCallId, params, signal) {
            const result = await client.callTool(
              name,
              (params ?? {}) as Record<string, unknown>,
              signal,
            );
            const content = mcpModelContent(result);
            if (isMcpToolError(result) && !content.some((part) => part.type === "text" && part.text.length > 0)) {
              content.push({ type: "text", text: "MCP tool f5/" + name + " returned an error" });
            }
            return {
              content,
              structuredContent: mcpScriptResult(result),
              details: { server: "f5", tool: name },
              ...(isMcpToolError(result) ? { isError: true } : {}),
            };
          },
        });
    }
  };

  const ensureStarted = () => {
    if (started !== undefined) return started;
    const attempt = (async () => {
      const signal = AbortSignal.timeout(10_000);
      await client.connect(signal);
      catalog = await client.listTools(signal);
      registerTools();
    })();
    started = attempt;
    void attempt.catch(() => {
      if (started === attempt) started = undefined;
    });
    return attempt;
  };

  // CLI extensions load before builtins, and Pi keeps the first registration
  // of a tool name. Register now so the bridge owns the F5 namespace even when
  // mcp.json configures it; retry a failed connection at session_start.
  await ensureStarted().catch(() => undefined);

  const reconcileDiscovery = (ctx: Pick<ExtensionContext, "model">) => {
    if (!supportsExposure) return;
    // A disabled or replaced search builtin cannot discover deferred tools.
    const hasToolSearch = hasBuiltinToolSearch();
    const exposureChanged = deferOptionalTools !== hasToolSearch;
    deferOptionalTools = hasToolSearch;
    if (exposureChanged) registerTools();
    const active = pi.getActiveTools();
    // Completion gateways can silently drop calls to undeclared tools named
    // in history or guidance. Eagerly load F5 schemas, including after tree
    // restores, while retaining deferred exposure for Pi's allowlist rules.
    // Pi still applies --tools/--exclude-tools to this active loadout.
    const required = [
      ...(hasToolSearch ? ["tool_search"] : []),
      ...(ctx.model?.api === "openai-completions" ? catalog.map((tool) => "mcp__f5__" + tool.name) : []),
    ];
    const missing = required.filter((name) => !active.includes(name));
    if (missing.length > 0) pi.setActiveTools([...active, ...missing]);
  };

  // Tree navigation restores its saved loadout after session_start.
  pi.on("session_tree", (_event, ctx) => reconcileDiscovery(ctx));
  pi.on("model_select", (_event, ctx) => reconcileDiscovery(ctx));
  pi.on("session_start", async (_event, ctx) => {
    reconcileDiscovery(ctx);
    try {
      await ensureStarted();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      ctx.ui.notify(\`f5 MCP unavailable: \${message}\`, "warning");
    }
  });

  // Deliver orchestration guidance through pi's real system-prompt channel.
  // Wrapping the first user message instead would stop it from starting
  // with "/" and silently break slash-command expansion.
  pi.on("before_agent_start", (event, ctx) => {
    reconcileDiscovery(ctx);
    return { systemPrompt: event.systemPrompt + "\\n\\n" + ORCHESTRATION_INSTRUCTIONS };
  });
}
`;
