import {
  CanonicalRequestType,
  ProviderApprovalDecision,
  ProviderRequestKind,
} from "@t3tools/contracts";
import { Schema } from "effect";

const APPROVAL_LABELS: Record<typeof ProviderApprovalDecision.Type, string> = {
  accept: "Approve once",
  acceptForSession: "Allow for this session",
  acceptAlways: "Always allow",
  decline: "Decline",
  cancel: "Cancel",
};

/** Provenance is assigned by the adapter that installed the server, never by a tool prefix. */
export interface AutomationToolProvenance {
  readonly serverName: string;
  readonly verified: boolean;
  /**
   * `chrome-mask` is installed before Claude in Chrome is verified (and for lookalikes):
   * it masks everything and grants no trusted provenance, image persistence or badge.
   * `claude-chrome` is registered only after F5 verified the CLI's own server.
   */
  readonly kind:
    | "f5-computer"
    | "claude-builtin"
    | "codex-builtin"
    | "claude-chrome"
    | "chrome-mask";
}
export function isComputerAutomationTool(
  toolName: string,
  provenance: AutomationToolProvenance | undefined,
): boolean {
  if (!provenance?.verified) return false;
  const prefix = `mcp__${provenance.serverName}__`;
  return toolName.startsWith(prefix) && toolName.length > prefix.length;
}
const SAFE_STRING_FIELDS = new Set([
  "op",
  "appId",
  "appName",
  "elementRef",
  "snapshotId",
  "displayId",
  "geometryGeneration",
  "mimeType",
  "attachmentId",
  "_tag",
  "outcome",
  "status",
]);
const SAFE_NUMERIC_FIELDS = new Set([
  "x",
  "y",
  "width",
  "height",
  "count",
  "clickCount",
  "repeat",
  "durationMs",
  "sizeBytes",
  "elapsedMs",
  "omitted",
  "mcpImagesOmitted",
]);
const SAFE_CONTAINER_FIELDS = new Set([
  "geometry",
  "bounds",
  "rect",
  "modelSize",
  "cursor",
  "mcpImages",
  "attachments",
  "error",
  "result",
  "input",
  "structuredContent",
]);
/** Whitelist prevents nested provider errors, AX names/values and JavaScript source leaking. */
export function sanitizeAutomationActivity(
  value: unknown,
  provenance: AutomationToolProvenance,
): unknown {
  if (!provenance.verified) return value;
  const visit = (node: unknown, depth: number): unknown => {
    if (depth > 12 || node === null || typeof node !== "object") return {};
    if (Array.isArray(node)) return node.slice(0, 400).map((entry) => visit(entry, depth + 1));
    const output: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(node)) {
      if (SAFE_STRING_FIELDS.has(key) && typeof entry === "string")
        output[key] = entry.slice(0, 1024);
      else if (SAFE_NUMERIC_FIELDS.has(key) && typeof entry === "number" && Number.isFinite(entry))
        output[key] = entry;
      else if (SAFE_CONTAINER_FIELDS.has(key) && entry !== null && typeof entry === "object")
        output[key] = visit(entry, depth + 1);
    }
    return output;
  };
  // cua_repl source and text output have no trustworthy field-level structure.
  if (provenance.kind === "codex-builtin") return { sanitized: true, backend: "codex-builtin" };
  if (provenance.kind === "chrome-mask") return { sanitized: true };
  const safe = visit(value, 0);
  return Array.isArray(safe) ? safe : { ...(safe as object), sanitized: true };
}
export function sanitizeAutomationToolPayload(
  toolName: string,
  value: unknown,
  provenance: AutomationToolProvenance | undefined,
): unknown {
  return isComputerAutomationTool(toolName, provenance)
    ? sanitizeAutomationActivity(value, provenance!)
    : value;
}

/** Per-thread registration by adapters; project servers cannot populate this registry. */
export class AutomationEventSanitizer {
  private readonly servers = new Map<string, ReadonlyArray<AutomationToolProvenance>>();
  private readonly items = new Map<string, AutomationToolProvenance>();
  private readonly blocks = new Map<string, AutomationToolProvenance>();
  private readonly overflow = new Set<string>();
  private readonly retainers = new Map<string, number>();
  private readonly pendingClear = new Set<string>();
  /** An adapter owns provenance until its event producer/consumer has stopped. */
  retain(threadId: string): () => void {
    this.retainers.set(threadId, (this.retainers.get(threadId) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const count = (this.retainers.get(threadId) ?? 1) - 1;
      if (count) this.retainers.set(threadId, count);
      else {
        this.retainers.delete(threadId);
        if (this.pendingClear.delete(threadId)) this.clear(threadId);
      }
    };
  }
  constructor(private readonly itemLimit = 65_536) {}
  private remember(
    threadId: string,
    id: string,
    provenance: AutomationToolProvenance,
    block = false,
  ): void {
    const map = block ? this.blocks : this.items;
    const key = `${threadId}\0${id}`;
    if (map.has(key) || this.items.size + this.blocks.size < this.itemLimit)
      map.set(key, provenance);
    else this.overflow.add(threadId);
  }
  register(threadId: string, provenance: AutomationToolProvenance): void {
    this.servers.set(threadId, [
      ...(this.servers.get(threadId) ?? []).filter(
        (entry) => entry.serverName !== provenance.serverName,
      ),
      provenance,
    ]);
  }
  registerItem(threadId: string, itemId: string, serverName: string): void {
    const provenance = this.servers
      .get(threadId)
      ?.find((entry) => entry.serverName === serverName && entry.verified);
    if (provenance) this.remember(threadId, itemId, provenance);
  }
  clear(threadId: string): void {
    if (this.retainers.has(threadId)) {
      this.pendingClear.add(threadId);
      return;
    }
    this.servers.delete(threadId);
    this.overflow.delete(threadId);
    for (const map of [this.items, this.blocks])
      for (const key of map.keys()) if (key.startsWith(`${threadId}\0`)) map.delete(key);
  }
  sanitize(threadId: string, value: unknown): unknown {
    const servers = this.servers.get(threadId)?.filter((entry) => entry.verified) ?? [];
    if (!servers.length) return value;
    const lookup = (node: unknown, depth = 0): AutomationToolProvenance | undefined => {
      if (depth > 8 || node === null || typeof node !== "object") return undefined;
      if (Array.isArray(node)) {
        for (const child of node) {
          const found = lookup(child, depth + 1);
          if (found) return found;
        }
        return undefined;
      }
      const record = node as Record<string, unknown>;
      const name =
        typeof record.toolName === "string"
          ? record.toolName
          : typeof record.name === "string"
            ? record.name
            : "";
      const server = record.server ?? record.serverName;
      const id = record.tool_use_id ?? record.toolCallId ?? record.itemId ?? record.id;
      const found =
        servers.find(
          (entry) => isComputerAutomationTool(name, entry) || entry.serverName === server,
        ) ?? (typeof id === "string" ? this.items.get(`${threadId}\0${id}`) : undefined);
      if (found) return found;
      for (const key of [
        "payload",
        "data",
        "event",
        "raw",
        "content_block",
        "content",
        "message",
        "item",
        "tool",
        "params",
        "update",
        "toolCall",
      ]) {
        const nested = lookup(record[key], depth + 1);
        if (nested) return nested;
      }
      return undefined;
    };
    const registerCalls = (node: unknown, depth = 0): void => {
      if (depth > 32 || node === null || typeof node !== "object") return;
      if (Array.isArray(node)) {
        for (const child of node) registerCalls(child, depth + 1);
        return;
      }
      const record = node as Record<string, unknown>;
      const name = record.toolName ?? record.name;
      const match =
        typeof name === "string"
          ? servers.find((entry) => isComputerAutomationTool(name, entry))
          : undefined;
      const id = record.toolCallId ?? record.itemId ?? record.id;
      if (match && typeof id === "string") this.remember(threadId, id, match);
      for (const key of [
        "message",
        "content",
        "content_block",
        "payload",
        "event",
        "raw",
        "item",
        "tool",
        "params",
        "update",
        "toolCall",
      ])
        registerCalls(record[key], depth + 1);
    };
    registerCalls(value);
    const envelopeStrings = new Set([
      "type",
      "eventId",
      "provider",
      "threadId",
      "turnId",
      "itemId",
      "id",
      "tool_use_id",
      "toolCallId",
      "createdAt",
      "method",
      "kind",
      "itemType",
      "status",
      "server",
      "serverName",
    ]);
    const visit = (node: unknown, depth: number, inherited?: AutomationToolProvenance): unknown => {
      if (depth > 32 || node === null || typeof node !== "object") return inherited ? {} : node;
      if (Array.isArray(node)) return node.map((entry) => visit(entry, depth + 1, inherited));
      const record = node as Record<string, unknown>;
      let name =
        typeof record.toolName === "string"
          ? record.toolName
          : typeof record.name === "string"
            ? record.name
            : "";
      const itemId = record.tool_use_id ?? record.toolCallId ?? record.itemId ?? record.id;
      const payload = record.payload as Record<string, unknown> | undefined;
      const assistantEnvelope =
        (record.type === "content.delta" &&
          (payload?.streamKind === "assistant_text" || payload?.kind === "text")) ||
        payload?.itemType === "assistant_message" ||
        record.type === "assistant" ||
        record.role === "assistant" ||
        record.type === "user" ||
        record.type === "text" ||
        record.type === "text_delta";
      const provenance = assistantEnvelope ? undefined : (lookup(record) ?? inherited);
      // Codex reports the server and tool separately inside data.item. Rebuild
      // the identity only for the server registered by this session's adapter.
      if (
        !name &&
        provenance &&
        (record.server ?? record.serverName) === provenance.serverName &&
        typeof record.tool === "string" &&
        record.tool.length > 0 &&
        record.tool.length <= 200
      )
        name = `mcp__${provenance.serverName}__${record.tool}`;
      if (provenance && typeof itemId === "string" && !assistantEnvelope)
        this.remember(threadId, itemId, provenance);
      if (record.type === "content_block_start" && typeof record.index === "number") {
        const block = record.content_block as Record<string, unknown> | undefined;
        const blockName = typeof block?.name === "string" ? block.name : "";
        const match = servers.find((entry) => isComputerAutomationTool(blockName, entry));
        if (match) this.remember(threadId, String(record.index), match, true);
      }
      const blockProvenance =
        typeof record.index === "number"
          ? this.blocks.get(`${threadId}\0${record.index}`)
          : undefined;
      if (record.type === "content_block_delta" && blockProvenance)
        return { type: record.type, index: record.index, delta: { sanitized: true } };
      if (record.type === "content_block_stop" && typeof record.index === "number")
        this.blocks.delete(`${threadId}\0${record.index}`);
      const result: Record<string, unknown> = {};
      for (const [key, entry] of Object.entries(record)) {
        if (!provenance) result[key] = visit(entry, depth + 1);
        else if (key === "computerTool" && entry === true) result[key] = true;
        else if (
          (envelopeStrings.has(key) || SAFE_STRING_FIELDS.has(key)) &&
          typeof entry === "string"
        )
          result[key] = entry.slice(0, 1024);
        else if (
          (SAFE_NUMERIC_FIELDS.has(key) || key === "index" || key === "sequence") &&
          typeof entry === "number" &&
          Number.isFinite(entry)
        )
          result[key] = entry;
        else if (
          [
            "payload",
            "event",
            "raw",
            "content_block",
            "data",
            "item",
            "params",
            "update",
            "toolCall",
          ].includes(key) &&
          entry !== null &&
          typeof entry === "object"
        )
          result[key] = visit(entry, depth + 1, provenance);
        else if (entry !== null && typeof entry === "object")
          result[key] = sanitizeAutomationActivity(entry, provenance);
      }
      if (provenance) {
        result.sanitized = true;
        // Approval envelopes are control metadata, not tool I/O. Without their
        // correlation and advertised decisions, the UI cannot settle a pending call.
        if (
          depth === 0 &&
          (record.type === "request.opened" ||
            record.type === "request.resolved" ||
            record.kind === "request")
        ) {
          if (typeof record.requestId === "string") result.requestId = record.requestId;
          if (Schema.is(ProviderRequestKind)(record.requestKind))
            result.requestKind = record.requestKind;
          const payload = record.payload;
          if (payload && typeof payload === "object" && !Array.isArray(payload)) {
            const original = payload as Record<string, unknown>;
            const preserved = (
              result.payload && typeof result.payload === "object" ? result.payload : {}
            ) as Record<string, unknown>;
            if (Schema.is(CanonicalRequestType)(original.requestType))
              preserved.requestType = original.requestType;
            if (Schema.is(ProviderApprovalDecision)(original.decision))
              preserved.decision = original.decision;
            if (Array.isArray(original.approvalOptions))
              preserved.approvalOptions = original.approvalOptions
                .slice(0, 16)
                .flatMap((option: unknown) => {
                  const decision =
                    option && typeof option === "object"
                      ? (option as Record<string, unknown>).decision
                      : undefined;
                  return Schema.is(ProviderApprovalDecision)(decision)
                    ? [{ decision, label: APPROVAL_LABELS[decision] }]
                    : [];
                });
            const presentation = original.presentation;
            if (presentation && typeof presentation === "object") {
              const flags: Record<string, boolean> = {};
              for (const key of ["defaultToNo", "suppressAlwaysAllowRule"] as const) {
                const flag = (presentation as Record<string, unknown>)[key];
                if (typeof flag === "boolean") flags[key] = flag;
              }
              preserved.presentation = flags;
            }
            result.payload = preserved;
          }
        }
        // AX/UIA names are never tool identities, even inside a trusted result.
        if (isComputerAutomationTool(name, provenance)) {
          result.toolName = name;
          if (typeof record.name === "string") result.name = name;
        }
      }
      return result;
    };
    // Eviction could expose a late result whose tool identity was forgotten.
    // Once saturated, conservatively redact this thread until session release.
    return visit(value, 0, this.overflow.has(threadId) ? servers[0] : undefined);
  }
  isComputerItem(threadId: string, itemId: string): boolean {
    if (this.overflow.has(threadId)) return true;
    const provenance = this.items.get(`${threadId}\0${itemId}`);
    return provenance !== undefined && provenance.kind !== "chrome-mask";
  }
  /** Masks one server's events (by name) until a trusted registration replaces it. */
  mask(threadId: string, serverName: string): void {
    const current = this.servers.get(threadId)?.find((entry) => entry.serverName === serverName);
    if (current && current.kind !== "chrome-mask") return;
    this.register(threadId, { serverName, verified: true, kind: "chrome-mask" });
  }
}
export const automationEventSanitizer = new AutomationEventSanitizer();
