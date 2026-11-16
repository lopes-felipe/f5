/**
 * MCP server-name helpers with no schema dependencies. Startup code such as
 * provider options imports these directly, so it does not pull MCP validation
 * and config merging into the web app's initial bundle.
 */
export const MAX_SERVER_NAME_LENGTH = 128;

export function trimToUndefined(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

export function mcpServerNameKey(name: string): string {
  return name.trim().toLowerCase();
}

export function normalizeServerName(name: string): string | undefined {
  const trimmed = trimToUndefined(name);
  return trimmed && trimmed.length <= MAX_SERVER_NAME_LENGTH ? trimmed : undefined;
}
