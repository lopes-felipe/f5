import type { CodexControlClient, CodexControlMcpServerStatus } from "./CodexControlClient.ts";

function normalizeServerName(name: string): string {
  return name.trim().toLowerCase();
}

export function codexServerNamesMatch(left: string, right: string): boolean {
  return normalizeServerName(left) === normalizeServerName(right);
}

export function findCodexServerStatusByName(
  statuses: ReadonlyArray<CodexControlMcpServerStatus>,
  name: string,
): CodexControlMcpServerStatus | undefined {
  return statuses.find((status) => codexServerNamesMatch(status.name, name));
}

export function codexServerStatusHasAuthenticatedOauth(
  status: CodexControlMcpServerStatus | undefined,
): boolean {
  return status?.authStatus === "oAuth" || status?.authStatus === "bearerToken";
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
