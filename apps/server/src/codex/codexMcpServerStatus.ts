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
    return matches.length === 1 ? { ...status, ...matches[0], name: status.name } : status;
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
): Promise<ReadonlyArray<CodexControlMcpServerStatus>> {
  const statuses: CodexControlMcpServerStatus[] = [];
  let cursor: string | undefined;

  while (true) {
    const page = await client.listMcpServerStatus(cursor, 100);
    statuses.push(...page.data);
    if (!page.nextCursor) {
      return statuses;
    }
    cursor = page.nextCursor;
  }
}
