import type {
  McpObservedServerStatus,
  McpReloadError,
  McpReloadResult,
  McpReloadServerStatus,
} from "@t3tools/contracts";

/** Delays between in-place reconcile attempts before the result is reported as-is. */
export const MCP_RELOAD_RETRY_DELAYS_MS = [500, 1_500, 4_000] as const;

import { classifyMcpOwnership, type ObservedMcpServer } from "./mcpObservation.ts";
export type { ObservedMcpServer } from "./mcpObservation.ts";

const trimmed = (value: string | undefined, max = 2_000): string | undefined => {
  const text = value?.trim();
  return text ? text.slice(0, max) : undefined;
};

export function claudeObservedMcpStatus(status: string): McpObservedServerStatus {
  switch (status) {
    case "connected":
    case "pending":
    case "needs-auth":
    case "failed":
    case "disabled":
      return status;
    default:
      return "unknown";
  }
}

/**
 * Codex reports a server that needs (re)authentication as a failed startup whose error
 * asks the user to run `codex mcp login <name>`. Other wording, such as a wrapped CLI's
 * "is not logged in", stays a failure: Codex OAuth cannot fix it.
 */
export function isCodexMcpLoginRequiredError(error: string | undefined): boolean {
  return !!error && /\brun `?codex mcp login\b/i.test(error);
}

export function codexObservedMcpStatus(input: {
  readonly startupStatus?: string;
  readonly authStatus?: string;
  readonly error?: string;
  /** Codex 0.160.1 omits `startupStatus` from the list; reported tools mean it connected. */
  readonly hasTools?: boolean;
}): McpObservedServerStatus {
  if (input.authStatus === "notLoggedIn") return "needs-auth";
  switch (input.startupStatus) {
    case "ready":
      return "connected";
    case "starting":
      return "pending";
    case "failed":
      return isCodexMcpLoginRequiredError(input.error) ? "needs-auth" : "failed";
    case "cancelled":
      return "disabled";
    case "needs-auth":
      return "needs-auth";
  }
  if (input.startupStatus !== undefined) return "unknown";
  if (isCodexMcpLoginRequiredError(input.error)) return "needs-auth";
  if (trimmed(input.error)) return "failed";
  return input.hasTools ? "connected" : "unknown";
}

/**
 * Builds a reload result from the desired F5-owned server names and the
 * status the session reports afterwards. `observed` is undefined when the
 * provider cannot report status; the result then rests on `errors` alone.
 * Pending and needs-auth servers count as applied: a restart would not help.
 * `notices` are shown with the errors but do not block convergence, because
 * neither a retry nor a restart changes them (for example a name conflict).
 */
export function summarizeMcpReload(input: {
  readonly desired: ReadonlyArray<string>;
  readonly observed: ReadonlyArray<ObservedMcpServer> | undefined;
  readonly errors?: ReadonlyArray<McpReloadError>;
  readonly notices?: ReadonlyArray<McpReloadError>;
  readonly sameName?: (left: string, right: string) => boolean;
}): McpReloadResult {
  const result = summarizeBlockingMcpReload(input);
  return input.notices?.length
    ? { ...result, errors: [...input.notices, ...result.errors] }
    : result;
}

function summarizeBlockingMcpReload(input: {
  readonly desired: ReadonlyArray<string>;
  readonly observed: ReadonlyArray<ObservedMcpServer> | undefined;
  readonly errors?: ReadonlyArray<McpReloadError>;
  readonly sameName?: (left: string, right: string) => boolean;
}): McpReloadResult {
  const sameName = input.sameName ?? ((left: string, right: string) => left === right);
  const isDesired = (name: string) => input.desired.some((entry) => sameName(entry, name));
  const errors: McpReloadError[] = [...(input.errors ?? [])];
  const servers: McpReloadServerStatus[] = [];
  for (const server of input.observed ?? []) {
    const name = trimmed(server.name, 200);
    if (!name) continue;
    const error = trimmed(server.error);
    servers.push({
      name,
      status: server.status,
      owned: server.ownership === "managed" || (server.ownership === undefined && isDesired(name)),
      ...(error ? { error } : {}),
    });
  }

  if (input.observed !== undefined) {
    for (const name of input.desired) {
      const matches = servers.filter((server) => sameName(server.name, name));
      const observed = matches.length === 1 && matches[0]?.owned ? matches[0] : undefined;
      if (matches.length > 1) {
        errors.push({
          server: name,
          message: `The provider reports conflicting names: ${matches.map((server) => server.name).join(", ")}.`,
        });
      } else if (!observed) {
        if (!errors.some((error) => error.server === name))
          errors.push({ server: name, message: "The session does not report this server." });
      } else if (observed.status === "failed" && !errors.some((error) => error.server === name)) {
        errors.push({ server: name, message: observed.error ?? "The server failed to connect." });
      }
    }
  }

  return { converged: errors.length === 0, restartRequired: false, servers, errors };
}

interface ClaudeMcpControl<TConfig> {
  readonly mcpServerStatus?: () => Promise<
    ReadonlyArray<{
      readonly name: string;
      readonly status: string;
      readonly error?: string;
      readonly source?: string;
      readonly scope?: string;
    }>
  >;
  readonly setMcpServers?: (servers: Record<string, TConfig>) => Promise<{
    readonly added: ReadonlyArray<string>;
    readonly removed?: ReadonlyArray<string>;
    readonly errors: Readonly<Record<string, string>>;
  }>;
  readonly reconnectMcpServer?: (serverName: string) => Promise<void>;
}

/**
 * Reconciles the F5-owned dynamic MCP servers of a live Claude query.
 * Servers the CLI loaded from settings files or plugins are never named in
 * the payload, so they are neither replaced nor removed by omission; a
 * desired server whose name they already use is skipped with a notice.
 * Status is always re-read after the change, including after errors.
 */
export async function reconcileClaudeMcpServers<TConfig>(input: {
  readonly query: ClaudeMcpControl<TConfig>;
  readonly desired: Readonly<Record<string, TConfig>>;
  readonly owned: ReadonlySet<string>;
  /** Install host policy for the actual payload before the CLI can expose its tools. */
  readonly beforeSetServers?: (names: ReadonlySet<string>) => void;
}): Promise<{
  readonly result: McpReloadResult;
  readonly owned: ReadonlySet<string>;
  readonly applied?: Record<string, TConfig>;
}> {
  const { query } = input;
  if (!query.setMcpServers || !query.mcpServerStatus) {
    return {
      result: restartRequiredMcpReload("This Claude runtime cannot change MCP servers in place."),
      owned: input.owned,
    };
  }

  const before = await query.mcpServerStatus();
  const notices: McpReloadError[] = [];
  const payload: Record<string, TConfig> = {};
  for (const [name, config] of Object.entries(input.desired)) {
    const existing = before.find((server) => server.name === name);
    if (existing && classifyMcpOwnership(existing, input.owned) !== "managed") {
      const origin = existing.source ?? existing.scope ?? "settings or plugin";
      notices.push({
        server: name,
        message: `A ${origin} server already uses this name; F5 left it in place.`,
      });
      continue;
    }
    payload[name] = config;
  }

  const attemptedOwned = new Set([...input.owned, ...Object.keys(payload)]);
  input.beforeSetServers?.(attemptedOwned);
  let setResult: Awaited<ReturnType<NonNullable<ClaudeMcpControl<TConfig>["setMcpServers"]>>>;
  try {
    setResult = await query.setMcpServers(payload);
  } catch (cause) {
    const detail = cause instanceof Error ? trimmed(cause.message, 300) : undefined;
    return {
      result: restartRequiredMcpReload(
        `Claude could not change MCP servers in place${detail ? ` (${detail})` : ""}.`,
      ),
      // A rejected request may have partially installed its payload. Keep those
      // names covered by host policy until a later read confirms removal.
      owned: attemptedOwned,
    };
  }

  const owned = new Set(Object.keys(payload));
  // An unchanged server keeps its failed connection; ask for a fresh attempt.
  for (const server of before) {
    if (!owned.has(server.name) || server.status !== "failed") continue;
    if (setResult.added.includes(server.name)) continue;
    await query.reconnectMcpServer?.(server.name).catch(() => undefined);
  }

  const after = await query.mcpServerStatus().catch(() => undefined);
  // Claude keeps servers passed at launch when a payload omits them (verified
  // live on CLI 2.1.292); only a restart drops them. They stay owned so every
  // later reconcile keeps reporting the pending restart. Without a status
  // read, only the CLI's `removed` list proves a removal.
  const removed = new Set(setResult.removed ?? []);
  const lingering = [...input.owned].filter(
    (name) =>
      !(name in payload) &&
      !removed.has(name) &&
      (after === undefined ||
        after.some(
          (server) =>
            server.name === name && classifyMcpOwnership(server, input.owned) === "managed",
        )),
  );
  for (const name of lingering) owned.add(name);
  const summarized = summarizeMcpReload({
    desired: Object.keys(payload),
    observed: after?.map((server) => ({
      name: server.name,
      status: claudeObservedMcpStatus(server.status),
      ownership: classifyMcpOwnership(server, owned),
      ...(server.error ? { error: server.error } : {}),
    })),
    errors: Object.entries(setResult.errors ?? {}).map(([server, message]) => ({
      server,
      message: trimmed(message) ?? "The server failed to connect.",
    })),
    notices,
  });
  // A failed status read leaves the change unverified, so it is retried.
  const result: McpReloadResult =
    after === undefined
      ? {
          ...summarized,
          converged: false,
          errors: [
            ...summarized.errors,
            { message: "Claude did not report MCP status after the change." },
          ],
        }
      : summarized;
  if (lingering.length === 0) return { result, owned, applied: payload };
  return {
    result: {
      ...result,
      converged: false,
      restartRequired: true,
      errors: [
        ...result.errors,
        ...lingering.map((server) => ({
          server,
          message: "Claude keeps this server until the session restarts.",
        })),
      ],
    },
    owned,
    applied: payload,
  };
}

/** Order-independent key for comparing two translated MCP server configs. */
export function stableMcpConfigKey(value: unknown): string {
  const normalize = (entry: unknown): unknown => {
    if (Array.isArray(entry)) return entry.map(normalize);
    if (entry === null || typeof entry !== "object") return entry;
    return Object.fromEntries(
      Object.entries(entry as Record<string, unknown>)
        .filter(([, child]) => child !== undefined)
        .toSorted(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, normalize(child)]),
    );
  };
  return JSON.stringify(normalize(value));
}

export function restartRequiredMcpReload(message: string): McpReloadResult {
  return {
    converged: false,
    restartRequired: true,
    servers: [],
    errors: [{ message: trimmed(message) ?? "This session must restart to apply MCP changes." }],
  };
}

/** One-line, value-free description of a non-converged reload for a visible warning. */
export function describeMcpReloadFailure(result: McpReloadResult): string {
  const details = result.errors
    .slice(0, 5)
    .map((error) => (error.server ? `${error.server}: ${error.message}` : error.message))
    .join("; ");
  const prefix = result.restartRequired
    ? "MCP changes will apply when this session restarts at the next idle turn"
    : "Some MCP servers did not apply";
  return details ? `${prefix}. ${details}` : `${prefix}.`;
}
