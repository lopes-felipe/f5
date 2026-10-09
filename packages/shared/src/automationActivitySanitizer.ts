/** Provenance is assigned by the adapter that installed the server, never by a tool prefix. */
export interface AutomationToolProvenance {
  readonly serverName: string;
  readonly verified: boolean;
  readonly kind: "f5-computer" | "claude-builtin" | "codex-builtin";
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
  return provenance.kind === "codex-builtin"
    ? { sanitized: true, backend: "codex-builtin" }
    : { ...(visit(value, 0) as object), sanitized: true };
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
  register(threadId: string, provenance: AutomationToolProvenance): void {
    this.servers.set(threadId, [
      ...(this.servers.get(threadId) ?? []).filter(
        (entry) => entry.serverName !== provenance.serverName,
      ),
      provenance,
    ]);
  }
  clear(threadId: string): void {
    this.servers.delete(threadId);
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
      const id = record.tool_use_id ?? record.itemId ?? record.id;
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
        "item",
        "tool",
      ]) {
        const nested = lookup(record[key], depth + 1);
        if (nested) return nested;
      }
      return undefined;
    };
    const envelopeStrings = new Set([
      "type",
      "eventId",
      "provider",
      "threadId",
      "turnId",
      "itemId",
      "id",
      "tool_use_id",
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
      const name =
        typeof record.toolName === "string"
          ? record.toolName
          : typeof record.name === "string"
            ? record.name
            : "";
      const itemId = record.tool_use_id ?? record.itemId ?? record.id;
      const provenance = lookup(record) ?? inherited;
      if (provenance && typeof itemId === "string")
        this.items.set(`${threadId}\0${itemId}`, provenance);
      if (record.type === "content_block_start" && typeof record.index === "number") {
        const block = record.content_block as Record<string, unknown> | undefined;
        const blockName = typeof block?.name === "string" ? block.name : "";
        const match = servers.find((entry) => isComputerAutomationTool(blockName, entry));
        if (match) this.blocks.set(`${threadId}\0${record.index}`, match);
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
          ["payload", "event", "raw", "content_block"].includes(key) &&
          entry !== null &&
          typeof entry === "object"
        )
          result[key] = visit(entry, depth + 1, provenance);
        else if (entry !== null && typeof entry === "object")
          result[key] = sanitizeAutomationActivity(entry, provenance);
      }
      if (provenance) {
        result.sanitized = true;
        // AX/UIA names are never tool identities, even inside a trusted result.
        if (isComputerAutomationTool(name, provenance)) {
          result.toolName = name;
          if (typeof record.name === "string") result.name = name;
        }
      }
      return result;
    };
    return visit(value, 0);
  }
  isComputerItem(threadId: string, itemId: string): boolean {
    return this.items.has(`${threadId}\0${itemId}`);
  }
}
export const automationEventSanitizer = new AutomationEventSanitizer();
