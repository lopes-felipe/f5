import { readBoundedPages } from "./readBoundedPages.ts";
import { mcpServerNameKey } from "@t3tools/shared/mcpValidation";
import type { CodexControlClient, CodexControlMcpServerStatus } from "./CodexControlClient.ts";

export function codexServerNamesMatch(left: string, right: string): boolean {
  return mcpServerNameKey(left) === mcpServerNameKey(right);
}

export function findCodexServerStatusByName(
  statuses: ReadonlyArray<CodexControlMcpServerStatus>,
  name: string,
): CodexControlMcpServerStatus | undefined {
  const matches = statuses.filter((status) => codexServerNamesMatch(status.name, name));
  return matches.length === 1 ? matches[0] : undefined;
}

/** Merge a unique notification without hiding provider aliases or duplicating a casing variant. */
export function mergeCodexMcpStartupStatuses(
  statuses: ReadonlyArray<CodexControlMcpServerStatus>,
  notifications: ReadonlyArray<CodexControlMcpServerStatus>,
): CodexControlMcpServerStatus[] {
  const byName = new Map<string, CodexControlMcpServerStatus[]>();
  for (const notification of notifications) {
    const key = mcpServerNameKey(notification.name);
    const matches = byName.get(key);
    if (matches) matches.push(notification);
    else byName.set(key, [notification]);
  }
  const merged = statuses.map((status) => {
    const matches = byName.get(mcpServerNameKey(status.name)) ?? [];
    const exact = matches.filter((entry) => entry.name.trim() === status.name.trim());
    const notification =
      exact.length === 1 ? exact[0] : matches.length === 1 ? matches[0] : undefined;
    if (!notification) return status;
    const {
      error: notificationError,
      startupStatus: notificationStatus,
      ...metadata
    } = notification;
    const startupStatus = status.startupStatus ?? notificationStatus;
    const error =
      status.error ?? (status.startupStatus === undefined ? notificationError : undefined);
    return {
      ...metadata,
      ...status,
      ...(startupStatus ? { startupStatus } : {}),
      ...(error ? { error } : {}),
      name: status.name,
    };
  });
  const returnedKeys = new Set(statuses.map((status) => mcpServerNameKey(status.name)));
  const returnedNames = new Set(statuses.map((status) => status.name.trim()));
  return [
    ...merged,
    ...notifications.filter((notification) => {
      const key = mcpServerNameKey(notification.name);
      return (
        !returnedKeys.has(key) ||
        ((byName.get(key)?.length ?? 0) > 1 && !returnedNames.has(notification.name.trim()))
      );
    }),
  ];
}

export function codexServerStatusHasAuthenticatedOauth(
  status: CodexControlMcpServerStatus | undefined,
): boolean {
  return status?.authStatus === "oAuth" || status?.authStatus === "bearerToken";
}

function codexServerStatusHasReportedCapabilities(
  status: CodexControlMcpServerStatus | undefined,
): boolean {
  return (
    Object.keys(status?.tools ?? {}).length > 0 ||
    (status?.resources?.length ?? 0) > 0 ||
    (status?.resourceTemplates?.length ?? 0) > 0
  );
}

export function codexServerStatusCanReconcileCompletedOauthLogin(
  status: CodexControlMcpServerStatus | undefined,
): boolean {
  if (!codexServerStatusHasAuthenticatedOauth(status)) {
    return false;
  }

  if (status?.startupStatus === "failed" || status?.startupStatus === "cancelled") {
    return false;
  }

  return status?.startupStatus === "ready" || codexServerStatusHasReportedCapabilities(status);
}

export async function listAllCodexServerStatuses(
  client: CodexControlClient,
  serverName?: string,
): Promise<ReadonlyArray<CodexControlMcpServerStatus>> {
  return (await readCodexServerStatusPages(client, serverName ? { serverName } : {})).entries;
}

export async function readCodexServerStatusPages(
  client: CodexControlClient,
  options: { signal?: AbortSignal; deadline?: number; serverName?: string } = {},
) {
  const context = client.getMcpObservationContext?.();
  const pages = await readBoundedPages<CodexControlMcpServerStatus>({
    label: "mcpServerStatus/list",
    allowMissingCursor: true,
    maxItems: 1000,
    maxPageItems: 100,
    initialFailureIsPartial: true,
    ...options,
    request: async (cursor, remaining) => {
      if (!options.serverName) return client.listMcpServerStatus(cursor, 100, remaining);
      try {
        return await client.listMcpServerStatus(cursor, 100, remaining, options.serverName);
      } catch (error) {
        if (
          !error ||
          typeof error !== "object" ||
          !("code" in error) ||
          ![-32600, -32601, -32602].includes(Number(error.code))
        )
          throw error;
        return client.listMcpServerStatus(cursor, 100, remaining);
      }
    },
    decode: decodeCodexMcpServerStatus,
  });
  if (context && context !== client.getMcpObservationContext?.())
    throw new Error("The MCP configuration check was superseded.");
  return {
    ...pages,
    entries: mergeCodexMcpStartupStatuses(pages.entries, client.getMcpStartupStatuses?.() ?? []),
  };
}

export function decodeCodexMcpServerStatus(row: unknown): CodexControlMcpServerStatus | undefined {
  if (!row || typeof row !== "object" || Array.isArray(row)) return undefined;
  const record = row as Record<string, unknown>;
  if (typeof record.name !== "string" || !record.name.trim()) return undefined;
  for (const field of ["startupStatus", "authStatus", "error", "source", "scope"])
    if (record[field] != null && typeof record[field] !== "string") return undefined;
  if (record.tools != null && (typeof record.tools !== "object" || Array.isArray(record.tools)))
    return undefined;
  for (const field of ["resources", "resourceTemplates"])
    if (record[field] != null && !Array.isArray(record[field])) return undefined;
  return record as unknown as CodexControlMcpServerStatus;
}
