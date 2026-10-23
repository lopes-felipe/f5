import { AGENT_AUTOMATION_SUPPORT } from "@t3tools/shared/agentAutomationSupport";
import { integrationUnavailableDetail } from "@t3tools/shared/providerIntegrationCertification";
import { createComputerSessionScope } from "../../computer/ComputerSessionScope";
import type { ComputerAutomationBrokerRuntime } from "../../computer/ComputerAutomationBroker";
import {
  COMPUTER_TOOL_DEFINITIONS,
  COMPUTER_GUIDANCE,
  COMPUTER_TOOL_TIMEOUT_MS,
  classifyComputerTool,
} from "../../computer/computerMcpTools";
/**
 * Claude-side wiring for F5's agent browser: the in-process preview MCP server,
 * exact-provenance tool classification, and CLI launch flags for Claude in
 * Chrome. Claude never receives an F5 credential: the preview tools run inside
 * this process and close over the thread they were created for.
 */
import { randomUUID } from "node:crypto";

import {
  createSdkMcpServer,
  type McpSdkServerConfigWithInstance,
  type McpServerStatus,
  tool,
} from "@anthropic-ai/claude-agent-sdk";
import type { ThreadId } from "@t3tools/contracts";
import { Effect } from "effect";

import type { PreviewAutomationBrokerShape } from "../../mcp/PreviewAutomationBroker.ts";
import {
  callPreviewTool,
  chooseServerName,
  PREVIEW_OBSERVE_TOOL_NAMES,
  PREVIEW_TOOL_DEFINITIONS,
  PREVIEW_TOOL_TIMEOUT_MS,
  type PreviewToolName,
  isPreviewToolName,
} from "../../mcp/previewMcpTools.ts";

export const CLAUDE_PREVIEW_SERVER_BASE_NAME = "f5_preview";
/** Server names the Claude CLI uses for its built-in browser and computer integrations. */
export const CLAUDE_IN_CHROME_SERVER_NAME = "claude-in-chrome";
export const CLAUDE_COMPUTER_USE_SERVER_NAME = "computer-use";

export type AgentCapabilityState = "off" | "pending" | "connected" | "failed" | "unavailable";

/** Per-session record surfaced on `runtime.configured.agentBrowser`. */
export interface ClaudeAgentBrowserState {
  /** `verified` is undefined until the first `mcpServerStatus()` read checks provenance. */
  preview?: { readonly serverName: string; readonly installed: boolean; verified?: boolean };
  computer?: { readonly serverName: string; readonly installed: boolean; verified?: boolean };
  chrome?: { state: AgentCapabilityState; detail?: string; verified?: boolean };
  computerUse?: {
    state: AgentCapabilityState;
    backend?: "claude-builtin" | "codex-builtin" | "native";
    detail?: string;
  };
  /** `acceptForSession` on any mutating preview tool grants the whole family. */
  mutatingPreviewGranted: boolean;
}

/**
 * Claude's built-in desktop computer use stays unavailable: the CLI sets it up only in
 * interactive terminal sessions, never in the SDK sessions F5 runs, so F5 never starts
 * `claude --computer-use-mcp`. Claude in Chrome is gated by the shared certification
 * records (`@t3tools/shared/providerIntegrationCertification`); see docs/agent-browser.md.
 */
export const CLAUDE_COMPUTER_USE_CERTIFIED = false;

export const COMPUTER_USE_UNAVAILABLE_DETAIL = AGENT_AUTOMATION_SUPPORT.claudeAgent.builtin!;
/** Reason-specific copy for this machine; never a fixed "not verified" string. */
export function claudeInChromeUnavailableDetail(
  platform: string = process.platform,
  arch: string = process.arch,
): string {
  return (
    integrationUnavailableDetail("claude-chrome", platform, arch) ??
    "Claude in Chrome is unavailable for this session."
  );
}
export const CLAUDE_IN_CHROME_NEEDS_BUNDLED =
  "Claude in Chrome works only with F5's bundled Claude.";
export const CLAUDE_IN_CHROME_HOME_MISMATCH =
  "Claude in Chrome needs the provider to use your macOS home folder.";
export const CLAUDE_IN_CHROME_ISOLATED_PROFILE =
  "Claude in Chrome isn't available in isolated F5 profiles: Chrome only finds Claude through your real home folder, which this profile keeps separate.";
export const CLAUDE_IN_CHROME_START_FAILED =
  "Claude in Chrome did not start. It needs the Claude in Chrome extension and a claude.ai sign-in; API-key sign-in isn't supported. Open Chrome before asking Claude to use it.";
export const CLAUDE_IN_CHROME_EXTERNAL_CONFLICT =
  "Another Claude Code session changed the browser connection. Stop Chrome control there, then reconnect in F5.";

/**
 * Closed classification of one Claude in Chrome call. Multiplexed tools and batches
 * classify every nested action; anything F5 does not recognize is denied.
 */
export type ClaudeChromeToolClass =
  | { readonly kind: "observed" | "mutating" }
  | { readonly kind: "unsupported"; readonly reason: "unsupported-operation" }
  | { readonly kind: "untrusted" }
  | { readonly kind: "protocol-drift" };

const CHROME_OBSERVED_TOOLS = new Set([
  "read_page",
  "find",
  "get_page_text",
  "tabs_context_mcp",
  "read_console_messages",
  "read_network_requests",
  "shortcuts_list",
  "list_connected_browsers",
]);
const CHROME_MUTATING_TOOLS = new Set([
  "javascript_tool",
  "form_input",
  "navigate",
  "resize_window",
  "gif_creator",
  "upload_image",
  "tabs_create_mcp",
  "tabs_close_mcp",
  "shortcuts_execute",
  "switch_browser",
  "select_browser",
]);
const CHROME_COMPUTER_OBSERVED_ACTIONS = new Set(["screenshot", "zoom", "wait", "cursor_position"]);
const CHROME_COMPUTER_MUTATING_ACTIONS = new Set([
  "left_click",
  "right_click",
  "middle_click",
  "double_click",
  "triple_click",
  "left_click_drag",
  "left_mouse_down",
  "left_mouse_up",
  "key",
  "hold_key",
  "type",
  "scroll",
  "scroll_to",
  "hover",
  "mouse_move",
]);

function classifyChromeAction(
  name: string,
  input: unknown,
  nested: boolean,
): ClaudeChromeToolClass {
  if (CHROME_OBSERVED_TOOLS.has(name)) return { kind: "observed" };
  if (CHROME_MUTATING_TOOLS.has(name)) return { kind: "mutating" };
  if (name === "computer") {
    if (typeof input !== "object" || input === null) return { kind: "protocol-drift" };
    const record = input as { action?: unknown; save_to_disk?: unknown };
    if (typeof record.action !== "string") return { kind: "protocol-drift" };
    if (CHROME_COMPUTER_OBSERVED_ACTIONS.has(record.action))
      return record.save_to_disk === true ? { kind: "mutating" } : { kind: "observed" };
    if (CHROME_COMPUTER_MUTATING_ACTIONS.has(record.action)) return { kind: "mutating" };
    return { kind: "unsupported", reason: "unsupported-operation" };
  }
  if (name === "browser_batch" && !nested) {
    const actions = (input as { actions?: unknown } | null)?.actions;
    if (!Array.isArray(actions)) return { kind: "protocol-drift" };
    if (!actions.length) return { kind: "unsupported", reason: "unsupported-operation" };
    let mutating = false;
    for (const action of actions) {
      const item = action as { name?: unknown; input?: unknown } | null;
      if (typeof item !== "object" || item === null || typeof item.name !== "string")
        return { kind: "protocol-drift" };
      const result = classifyChromeAction(item.name, item.input, true);
      if (result.kind !== "observed" && result.kind !== "mutating") return result;
      mutating ||= result.kind === "mutating";
    }
    return { kind: mutating ? "mutating" : "observed" };
  }
  // file_upload, nested batches and unknown tools.
  return { kind: "unsupported", reason: "unsupported-operation" };
}

/**
 * `trusted` is true only after F5 verified the CLI's own server; lookalikes stay generic.
 * `toolNames` is the certified inventory: tools outside it are unsupported.
 */
export function classifyClaudeChromeTool(input: {
  readonly toolName: string;
  readonly toolInput: unknown;
  readonly trusted: boolean;
  readonly toolNames: ReadonlyArray<string>;
}): ClaudeChromeToolClass {
  if (!isClaudeInChromeTool(input.toolName)) return { kind: "untrusted" };
  if (!input.trusted) return { kind: "untrusted" };
  const name = input.toolName.slice(`mcp__${CLAUDE_IN_CHROME_SERVER_NAME}__`.length);
  if (!input.toolNames.includes(name))
    return { kind: "unsupported", reason: "unsupported-operation" };
  return classifyChromeAction(name, input.toolInput, false);
}

export function agentBrowserConfigPayload(
  state: ClaudeAgentBrowserState | undefined,
): Record<string, unknown> | undefined {
  if (!state) return undefined;
  const payload = {
    ...(state.preview
      ? {
          preview: {
            serverName: state.preview.serverName,
            installed: state.preview.installed,
            ...(state.preview.verified !== undefined ? { verified: state.preview.verified } : {}),
          },
        }
      : {}),
    ...(state.computer ? { computer: state.computer } : {}),
    ...(state.chrome
      ? {
          chrome: {
            state: state.chrome.state,
            ...(state.chrome.detail ? { detail: state.chrome.detail } : {}),
          },
        }
      : {}),
    ...(state.computerUse
      ? {
          computerUse: {
            state: state.computerUse.state,
            ...(state.computerUse.backend ? { backend: state.computerUse.backend } : {}),
            ...(state.computerUse.detail ? { detail: state.computerUse.detail } : {}),
          },
        }
      : {}),
  };
  return Object.keys(payload).length > 0 ? payload : undefined;
}

export interface ClaudePreviewServer {
  readonly serverName: string;
  readonly config: McpSdkServerConfigWithInstance;
  readonly dispose?: () => void;
  readonly endTurn?: (turnId: string) => void;
}

/**
 * Build the in-process preview server for one Claude session. Every handler
 * resolves live policy, so toggling browser access applies on the next call.
 */
export function makeClaudePreviewMcpServer(input: {
  readonly broker: PreviewAutomationBrokerShape;
  readonly threadId: ThreadId;
  readonly existingServerNames: ReadonlySet<string>;
}): ClaudePreviewServer {
  const serverName = chooseServerName(CLAUDE_PREVIEW_SERVER_BASE_NAME, input.existingServerNames);
  const automationSessionId = `claude:${randomUUID()}`;
  const tools = PREVIEW_TOOL_DEFINITIONS.map((definition) =>
    tool(
      definition.name,
      definition.description,
      definition.shape,
      async (args) => {
        const policy = await Effect.runPromise(input.broker.resolvePolicy(input.threadId));
        const result = await callPreviewTool(
          { broker: input.broker, policy, threadId: input.threadId, automationSessionId },
          definition.name,
          args,
        );
        return {
          content: result.content.map((block) => ({ ...block })),
          ...(result.structuredContent ? { structuredContent: result.structuredContent } : {}),
          ...(result.isError ? { isError: true } : {}),
        };
      },
      {
        annotations: { ...definition.annotations, title: definition.title },
        alwaysLoad: definition.alwaysLoad,
      },
    ),
  );
  return {
    serverName,
    config: createSdkMcpServer({
      name: serverName,
      version: "1",
      timeout: PREVIEW_TOOL_TIMEOUT_MS,
      tools,
    }),
  };
}

export function makeClaudeComputerMcpServer(input: {
  broker: ComputerAutomationBrokerRuntime;
  threadId: ThreadId;
  existingServerNames: ReadonlySet<string>;
}): ClaudePreviewServer {
  const serverName = chooseServerName("f5_computer", input.existingServerNames);
  const scope = createComputerSessionScope({
    broker: input.broker,
    threadId: input.threadId,
    serverName,
    provider: "claude",
  });
  let connectionId = randomUUID();
  return {
    serverName,
    dispose: scope.dispose,
    endTurn: scope.endTurn,
    config: (() => {
      const config = createSdkMcpServer({
        name: serverName,
        version: "2",
        instructions: COMPUTER_GUIDANCE,
        timeout: COMPUTER_TOOL_TIMEOUT_MS,
        tools: COMPUTER_TOOL_DEFINITIONS.map((definition) =>
          tool(
            definition.name,
            definition.description,
            definition.shape,
            async (args, extra) => {
              const result = await scope.call(
                definition.name,
                args,
                extra !== null &&
                  typeof extra === "object" &&
                  "requestId" in extra &&
                  (typeof extra.requestId === "string" || typeof extra.requestId === "number")
                  ? `${connectionId}:${JSON.stringify(extra.requestId)}`
                  : undefined,
              );
              return {
                content: result.content.map((block) => ({ ...block })),
                ...(result.structuredContent
                  ? { structuredContent: result.structuredContent }
                  : {}),
                ...(result.isError ? { isError: true } : {}),
              };
            },
            {
              annotations: { ...definition.annotations, title: definition.title },
              alwaysLoad: definition.alwaysLoad,
            },
          ),
        ),
      });
      if (config.instance?.server) {
        const initialized = config.instance.server.oninitialized;
        config.instance.server.oninitialized = () => {
          initialized?.();
          scope.resetConnection();
          connectionId = randomUUID();
        };
      }
      return config;
    })(),
  };
}
export function classifyF5ComputerTool(
  toolName: string,
  state: ClaudeAgentBrowserState | undefined,
  mcpServer: McpServerProvenance | undefined,
): "observe" | "consent" | "mutate" | undefined {
  const computer = state?.computer;
  if (
    !computer?.installed ||
    !computer.verified ||
    !toolName.startsWith(`mcp__${computer.serverName}__`)
  )
    return undefined;
  if (mcpServer && (mcpServer.name !== computer.serverName || mcpServer.source !== "sdk"))
    return undefined;
  return classifyComputerTool(toolName.slice(`mcp__${computer.serverName}__`.length));
}

export interface McpServerProvenance {
  readonly name: string;
  readonly source: string;
}

/**
 * Mark the preview server verified only when the CLI reports our exact name as
 * an in-process (`sdk`) server. A configured server can never report `sdk`.
 */
export function isVerifiedSdkServer(
  statuses: ReadonlyArray<Pick<McpServerStatus, "name" | "source">>,
  serverName: string,
): boolean {
  return statuses.some((status) => status.name === serverName && status.source === "sdk");
}

export type F5PreviewToolClass = "observe" | "mutate";

/**
 * Classify a tool call as one of F5's preview tools by exact server + tool
 * name. Unverified servers, mismatched provenance, and look-alike names from
 * project servers never classify, so they never inherit F5 exemptions.
 */
export function classifyF5PreviewTool(
  toolName: string,
  state: ClaudeAgentBrowserState | undefined,
  mcpServer: McpServerProvenance | undefined,
): F5PreviewToolClass | undefined {
  const preview = state?.preview;
  if (!preview?.installed || !preview.verified) return undefined;
  const prefix = `mcp__${preview.serverName}__`;
  if (!toolName.startsWith(prefix)) return undefined;
  const name = toolName.slice(prefix.length);
  if (!isPreviewToolName(name)) return undefined;
  if (mcpServer && (mcpServer.source !== "sdk" || mcpServer.name !== preview.serverName)) {
    return undefined;
  }
  return PREVIEW_OBSERVE_TOOL_NAMES.has(name as PreviewToolName) ? "observe" : "mutate";
}

/**
 * True when an F5 preview observe call writes an artifact file, which a read-only
 * workflow stage may not do: `preview_screenshot` always saves; snapshots on `save: true`.
 */
export function writesPreviewArtifact(toolName: string, toolInput: unknown): boolean {
  if (toolName.endsWith("__preview_screenshot")) return true;
  return (
    typeof toolInput === "object" &&
    toolInput !== null &&
    (toolInput as { readonly save?: unknown }).save === true
  );
}

export function isClaudeInChromeTool(toolName: string): boolean {
  return toolName.startsWith(`mcp__${CLAUDE_IN_CHROME_SERVER_NAME}__`);
}

export function isClaudeComputerUseTool(toolName: string): boolean {
  return toolName.startsWith(`mcp__${CLAUDE_COMPUTER_USE_SERVER_NAME}__`);
}

const CHROME_FLAG_KEYS = new Set(["chrome", "--chrome", "no-chrome", "--no-chrome"]);

/** F5 decides Claude in Chrome per session; user launch args can't override it. */
export function forceClaudeChromeFlag(
  extraArgs: Record<string, string | null> | undefined,
  chromeAllowed: boolean,
): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  for (const [key, value] of Object.entries(extraArgs ?? {})) {
    if (!CHROME_FLAG_KEYS.has(key)) out[key] = value;
  }
  out[chromeAllowed ? "chrome" : "no-chrome"] = null;
  return out;
}
