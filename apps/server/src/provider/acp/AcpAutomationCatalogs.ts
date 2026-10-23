import { resolveNativeOnlyComputerSelection } from "../../computer/computerBackendPolicy";
import { randomBytes } from "node:crypto";
import type { ProviderRuntimeEvent, ThreadId } from "@t3tools/contracts";
import {
  ACP_COMPUTER_CATALOG_VERIFIED,
  ACP_PREVIEW_CATALOG_VERIFIED,
  COMPUTER_AGENT_DISPLAY,
} from "@t3tools/shared/agentAutomationSupport";
import { automationEventSanitizer } from "@t3tools/shared/automationActivitySanitizer";
import { Effect, Scope } from "effect";
import type { InitializeResponse, McpServer } from "effect-acp/schema";
import type { ComputerAutomationBrokerRuntime } from "../../computer/ComputerAutomationBroker";
import { COMPUTER_TOOL_DEFINITIONS } from "../../computer/computerMcpTools";
import { z } from "zod";
import type {
  PreviewMcpHttpServerShape,
  PreviewMcpSessionConfig,
} from "../../mcp/PreviewMcpHttpServer";
import {
  agentBrowserConfigPayload,
  type ClaudeAgentBrowserState,
} from "../Layers/claudeAgentBrowser";
import { AcpCredentialScrubber, redactAcpLogPayload } from "./AcpNativeLogging";

type AcpProvider = "cursor" | "grok" | "antigravity" | "acp";
const object = (value: unknown): Record<string, unknown> | undefined =>
  value !== null &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
    ? (value as Record<string, unknown>)
    : undefined;
const nativeKinds = new Set([
  "read",
  "edit",
  "delete",
  "move",
  "search",
  "execute",
  "think",
  "fetch",
  "switch_mode",
]);
const sensitiveKeys = new Set([
  "text",
  "value",
  "keys",
  "app",
  "appId",
  "apps",
  "elementRef",
  "snapshotId",
]);
const schemas = COMPUTER_TOOL_DEFINITIONS.map((tool) => z.object(tool.shape).strict());

export function toAcpHttpMcpServer(config: PreviewMcpSessionConfig): McpServer {
  const definition = config.serverDefinition;
  const token = definition.bearerTokenEnvVar ? config.env[definition.bearerTokenEnvVar] : undefined;
  if (definition.type !== "http" || !definition.url || !token)
    throw new Error("ACP_MCP_CONFIGURATION_INVALID");
  return {
    type: "http",
    name: config.serverName,
    url: definition.url,
    headers: [{ name: "Authorization", value: `Bearer ${token}` }],
  };
}

/** Conservative classification requires no inference from tool titles or server-name prefixes. */
export function createAcpComputerClassifier(
  threadId: string,
  serverName: string,
  enabled: () => boolean,
) {
  const native = new Set<string>();
  const classify = (value: unknown, updateOnly = false): boolean => {
    if (!enabled()) return false;
    const call = object(value);
    const id =
      typeof call?.toolCallId === "string" &&
      call.toolCallId.length <= 1024 &&
      !/[\r\n]/.test(call.toolCallId)
        ? call.toolCallId
        : undefined;
    if (!id) return true;
    if (automationEventSanitizer.isComputerItem(threadId, id)) return true;
    if (updateOnly && !native.has(id)) {
      automationEventSanitizer.registerItem(threadId, id, serverName);
      return true;
    }
    if (
      updateOnly &&
      native.has(id) &&
      call?.rawInput === undefined &&
      (call?.kind === undefined || nativeKinds.has(String(call.kind))) &&
      !JSON.stringify({ title: call?.title }).includes(serverName) &&
      !/computer_[a-z_]+/.test(JSON.stringify({ title: call?.title }))
    )
      return false;
    const raw = object(call?.rawInput);
    const candidates = raw
      ? [
          raw,
          ...["arguments", "input", "args", "params"]
            .map((key) => object(raw[key]))
            .filter((entry) => entry !== undefined),
        ]
      : [];
    const provablyNative =
      native.size < 65_536 &&
      nativeKinds.has(String(call?.kind)) &&
      !!raw &&
      candidates.every(
        (entry) =>
          !Object.keys(entry).some((key) => sensitiveKeys.has(key)) &&
          !schemas.some((schema) => schema.safeParse(entry).success),
      ) &&
      !JSON.stringify({ title: call?.title, rawInput: raw }).includes(serverName) &&
      !/computer_[a-z_]+/.test(JSON.stringify({ title: call?.title, rawInput: raw }));
    if (provablyNative) {
      native.add(id);
      return false;
    }
    automationEventSanitizer.registerItem(threadId, id, serverName);
    return true;
  };
  return classify;
}

export function classifyAcpToolEvent(
  catalogs: Pick<AcpAutomationCatalogs, "computerCapable" | "classify">,
  event: { rawPayload: unknown; toolCall: { toolCallId: string; data: Record<string, unknown> } },
): boolean {
  if (!catalogs.computerCapable()) return false;
  const raw = object(event.rawPayload);
  const update = object(raw?.update);
  return catalogs.classify(
    update ?? { ...event.toolCall.data, ...event.toolCall },
    update?.sessionUpdate === "tool_call_update",
  );
}

export const prepareAcpAutomationCatalogs = (input: {
  threadId: ThreadId;
  provider: AcpProvider;
  scope: Scope.Closeable;
  preview?: PreviewMcpHttpServerShape;
  computer?: ComputerAutomationBrokerRuntime;
  readOnlyWorkflow: boolean;
  ordinarySession: boolean;
  /** Thread tools also work on the web server; automation remains desktop-only. */
  threadSession?: boolean;
  computerCapableLineage?: boolean;
  /** Certification/test seam; production drivers never supply overrides. */
  verification?: { preview?: boolean; computer?: boolean };
}) =>
  Effect.gen(function* () {
    const configs: PreviewMcpSessionConfig[] = [];
    const scrubber = new AcpCredentialScrubber();
    const serverName = `f5_computer_${randomBytes(4).toString("hex")}`;
    let computerCapable = input.computerCapableLineage === true;
    let disposed = false;
    let memo: ReadonlyArray<McpServer> | undefined;
    const state: ClaudeAgentBrowserState = { mutatingPreviewGranted: false };
    let installedGeneration: string | undefined;
    const statusListeners = new Set<() => void>();
    const release = automationEventSanitizer.retain(input.threadId);
    // Preserve conservative replay handling even if a later build removes a catalog.
    if (computerCapable)
      automationEventSanitizer.register(input.threadId, {
        serverName,
        verified: true,
        kind: "f5-computer",
      });
    const classify = createAcpComputerClassifier(input.threadId, serverName, () => computerCapable);
    const safeTool = (call: unknown, updateOnly = false) => {
      if (!classify(call, updateOnly)) return call;
      const raw = object(call);
      return {
        ...(typeof raw?.toolCallId === "string" && raw.toolCallId.length <= 1024
          ? { toolCallId: raw.toolCallId }
          : {}),
        title: "Tool activity",
        ...(nativeKinds.has(String(raw?.kind)) ? { kind: raw!.kind } : {}),
        ...(["pending", "in_progress", "completed", "failed"].includes(String(raw?.status))
          ? { status: raw!.status }
          : {}),
      };
    };
    const redactForLog = (value: unknown): unknown => {
      if (typeof value === "string") {
        try {
          return value
            .trim()
            .split(/\r?\n/)
            .map((line) => JSON.stringify(redactForLog(JSON.parse(line))))
            .join("\n");
        } catch {
          return "[unparsed ACP frame redacted]";
        }
      }
      const visit = (node: unknown, depth = 0): unknown => {
        if (depth > 32) return "[redacted]";
        if (Array.isArray(node)) return node.map((entry) => visit(entry, depth + 1));
        const raw = object(node);
        if (!raw) return node;
        if (raw.sessionUpdate === "tool_call" || raw.sessionUpdate === "tool_call_update")
          return safeTool(raw, raw.sessionUpdate === "tool_call_update");
        return Object.fromEntries(
          Object.entries(raw).map(([key, entry]) => [
            key,
            key === "toolCall"
              ? safeTool(entry)
              : computerCapable && key === "prompt"
                ? "[computer session prompt redacted]"
                : visit(entry, depth + 1),
          ]),
        );
      };
      return redactAcpLogPayload(
        automationEventSanitizer.sanitize(input.threadId, visit(value)),
        scrubber,
        0,
        false,
        computerCapable,
      );
    };
    const refresh = async () => {
      if (disposed || !state.computer?.installed || !installedGeneration || !input.computer) return;
      const before = JSON.stringify(state.computerUse);
      try {
        const context = await input.computer.context(input.threadId, installedGeneration);
        if (disposed || input.computer.generation(input.threadId) !== installedGeneration) return;
        const selection = resolveNativeOnlyComputerSelection({
          enabled: context.policy.computerUse,
          nativeStatus: input.computer.host.status(),
        });
        state.computerUse = selection.status.available
          ? { state: "connected", backend: "native" }
          : {
              state: selection.status.reason === "disabled" ? "off" : "unavailable",
              backend: "native",
              detail:
                selection.status.reason === "disabled"
                  ? "disabled by setting"
                  : (selection.status.detail ?? selection.status.reason),
            };
      } catch {
        if (!disposed)
          state.computerUse = { state: "unavailable", detail: "Computer policy is unavailable" };
      }
      if (!disposed && before !== JSON.stringify(state.computerUse))
        for (const listener of statusListeners) listener();
    };
    const offStatus = input.computer?.subscribe((event) => {
      if (
        (event.channel === "computer.host" && event.data.type === "status") ||
        (event.channel === "computer.observations.invalidated" &&
          event.data.threadId === input.threadId)
      )
        void refresh();
    });
    const dispose = () => {
      if (disposed) return;
      disposed = true;
      offStatus?.();
      statusListeners.clear();
      for (const config of configs) config.dispose();
      automationEventSanitizer.clear(input.threadId);
      release();
      // The scrubber remains owned by the stopped producer's callbacks; it is never persisted.
    };
    yield* Effect.addFinalizer(() => Effect.sync(dispose)).pipe(
      Effect.provideService(Scope.Scope, input.scope),
    );
    return {
      refresh,
      onChanged(listener: () => void) {
        statusListeners.add(listener);
        return () => statusListeners.delete(listener);
      },
      classify,
      redactForLog,
      scrubDiagnostic: (value: string) => scrubber.scrub(value),
      sanitizeEvent(event: ProviderRuntimeEvent): ProviderRuntimeEvent {
        if (!computerCapable) return event;
        if (
          (event.type === "item.started" ||
            event.type === "item.updated" ||
            event.type === "item.completed") &&
          automationEventSanitizer.isComputerItem(event.threadId, event.itemId ?? event.eventId)
        ) {
          return {
            ...event,
            payload: {
              itemType: "dynamic_tool_call",
              title: "Tool activity",
              ...(event.payload.status ? { status: event.payload.status } : {}),
              ...(event.payload.mcpImages ? { mcpImages: event.payload.mcpImages } : {}),
              ...(event.payload.mcpImagesOmitted
                ? { mcpImagesOmitted: event.payload.mcpImagesOmitted }
                : {}),
            },
            raw: undefined,
          };
        }
        if (
          event.type === "request.opened" &&
          event.payload.detail === "Tool inputs hidden while computer control is enabled"
        )
          return {
            ...event,
            payload: {
              requestType: event.payload.requestType,
              detail: "Tool inputs hidden while computer control is enabled",
              args: {},
              ...(event.payload.approvalOptions
                ? { approvalOptions: event.payload.approvalOptions }
                : {}),
            },
            raw: undefined,
          };
        return event;
      },
      computerCapable: () => computerCapable,
      hasSensitiveConfiguration: () => computerCapable || configs.length > 0,
      agentBrowser: () => agentBrowserConfigPayload(state),
      endTurn: (turnId: string) => {
        for (const config of configs) config.endTurn?.(turnId);
      },
      dispose,
      mcpServers(init: InitializeResponse): ReadonlyArray<McpServer> {
        if (memo) return memo;
        if (disposed) return [];
        const http = init.agentCapabilities?.mcpCapabilities?.http === true;
        const allowed = !!input.preview && !input.readOnlyWorkflow && input.ordinarySession && http;
        if (
          allowed &&
          (input.verification?.preview ?? ACP_PREVIEW_CATALOG_VERIFIED[input.provider])
        ) {
          const preview = input.preview!.createSessionConfig({
            threadId: input.threadId,
            provider: input.provider,
            serverName: `f5_preview_${randomBytes(4).toString("hex")}`,
          });
          for (const credential of Object.values(preview.env)) scrubber.register(credential);
          configs.push(preview);
          state.preview = { serverName: preview.serverName, installed: true, verified: true };
        }
        if (
          input.preview?.supportsThreadCatalog &&
          http &&
          !input.readOnlyWorkflow &&
          (input.threadSession ?? input.ordinarySession)
        ) {
          const thread = input.preview.createSessionConfig({
            threadId: input.threadId,
            provider: input.provider,
            catalog: "thread",
            existingServerNames: new Set(configs.map((config) => config.serverName)),
          });
          for (const credential of Object.values(thread.env)) scrubber.register(credential);
          configs.push(thread);
        }
        let detail = `Computer control for ${input.provider === "acp" ? "Custom ACP agent" : COMPUTER_AGENT_DISPLAY[input.provider].label} is awaiting verification`;
        if (input.verification?.computer ?? ACP_COMPUTER_CATALOG_VERIFIED[input.provider]) {
          if (input.readOnlyWorkflow)
            detail = "Computer control is unavailable in read-only workflows";
          else if (!input.ordinarySession)
            detail = "Computer control requires an ordinary F5 desktop session";
          else if (!input.preview) detail = "F5 automation tools are unavailable in this runtime";
          else if (!http) detail = "This agent can't connect to F5's tools";
          else if (!input.computer?.host.supportsAgentIdentity())
            detail = "Desktop update required";
          else if (allowed) {
            const computer = input.preview!.createSessionConfig({
              threadId: input.threadId,
              provider: input.provider,
              serverName,
              catalog: "computer",
            });
            for (const credential of Object.values(computer.env)) scrubber.register(credential);
            configs.push(computer);
            installedGeneration = input.computer.generation(input.threadId);
            computerCapable = true;
            state.computer = { serverName, installed: true, verified: true };
            state.computerUse = { state: "connected", backend: "native" };
          }
        }
        state.computerUse ??= { state: "unavailable", detail };
        return (memo = configs.map(toAcpHttpMcpServer));
      },
    };
  });
export type AcpAutomationCatalogs = Effect.Success<ReturnType<typeof prepareAcpAutomationCatalogs>>;
