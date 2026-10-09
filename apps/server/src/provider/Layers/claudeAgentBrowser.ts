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
  chrome?: { state: AgentCapabilityState; detail?: string };
  computerUse?: { state: AgentCapabilityState; backend?: "claude" | "native"; detail?: string };
  /** `acceptForSession` on any mutating preview tool grants the whole family. */
  mutatingPreviewGranted: boolean;
}

/**
 * Certification gates (see docs/agent-browser.md). Neither integration has passed:
 * - Computer use: the CLI only starts it in interactive terminal sessions, and its
 *   per-app access consent needs an elicitation answer the SDK host cannot give.
 *   Launching `claude --computer-use-mcp` as an external server is not a supported,
 *   session-bound backend, so F5 never starts it.
 * - Claude in Chrome: the CLI installs a Chrome native-messaging host; F5 has not
 *   verified what it writes or replaces, so it never passes `--chrome`.
 * While false the capability reports "unavailable" and every matching tool is denied.
 */
export const CLAUDE_COMPUTER_USE_CERTIFIED = false;
export const CLAUDE_IN_CHROME_CERTIFIED = false;

export const COMPUTER_USE_UNAVAILABLE_DETAIL =
  "Computer use is not available in F5 yet: Claude's app-access consent can't be answered safely outside its terminal app.";
export const CLAUDE_IN_CHROME_UNAVAILABLE_DETAIL =
  "Claude in Chrome is not available in F5 yet: its Chrome native-messaging setup hasn't been verified.";

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
