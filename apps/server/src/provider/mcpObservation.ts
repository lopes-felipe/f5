import { mcpServerNameKey } from "@t3tools/shared/mcpValidation";
import type { McpObservedServerStatus, McpInspectServerResult } from "@t3tools/contracts";

export interface ObservedMcpServer {
  readonly name: string;
  readonly status: McpObservedServerStatus;
  readonly error?: string;
  readonly ownership?: "managed" | "external" | "built-in";
  readonly origin?: string;
  readonly toolCount?: number;
  readonly authStatus?: "authenticated" | "unauthenticated" | "unknown";
  readonly tools?: McpInspectServerResult["tools"];
  readonly resources?: ReadonlyArray<unknown>;
  readonly resourceTemplates?: ReadonlyArray<unknown>;
}
export interface McpAdapterObservation {
  readonly servers: ReadonlyArray<ObservedMcpServer>;
  readonly complete: boolean;
  readonly omissions?: ReadonlyArray<string>;
  readonly capabilities: McpInspectServerResult["capabilities"];
}

/** Names alone never grant ownership to provider-loaded settings or plugin servers. */
export function classifyMcpOwnership(
  input: {
    name: string;
    source?: string;
    scope?: string;
  },
  owned: ReadonlySet<string>,
  builtIns: ReadonlySet<string> = new Set(),
): "managed" | "external" | "built-in" {
  if (
    builtIns.has(input.name) &&
    (!input.source || input.source === "sdk" || input.source === "dynamic")
  )
    return "built-in";
  const origin = input.source ?? input.scope;
  return owned.has(input.name) && (!origin || origin === "dynamic") ? "managed" : "external";
}

/** Codex aliases are accepted only when exactly one owned name matches. Claude names stay exact. */
export function resolveOwnedMcpServerName(
  names: ReadonlyArray<string>,
  requested: string,
  provider: string,
): string | undefined {
  const matches = names.filter((name) =>
    provider === "codex"
      ? mcpServerNameKey(name) === mcpServerNameKey(requested)
      : name === requested,
  );
  return matches.length === 1 ? matches[0] : undefined;
}
