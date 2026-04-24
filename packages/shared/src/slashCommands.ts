export const HOST_LOCAL_SLASH_COMMAND_NAMES = ["model", "plan", "default"] as const;

const HOST_LOCAL_SLASH_COMMAND_NAME_SET = new Set<string>(HOST_LOCAL_SLASH_COMMAND_NAMES);
const HOST_COMPATIBLE_RUNTIME_SLASH_COMMAND_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function isReservedHostLocalSlashCommandName(value: string): boolean {
  return HOST_LOCAL_SLASH_COMMAND_NAME_SET.has(value.trim().toLowerCase());
}

export function normalizeHostCompatibleRuntimeSlashCommandName(value: string): string | undefined {
  const normalized = value.trim().replace(/^\/+/, "");
  if (!HOST_COMPATIBLE_RUNTIME_SLASH_COMMAND_NAME_PATTERN.test(normalized)) {
    return undefined;
  }
  if (isReservedHostLocalSlashCommandName(normalized)) {
    return undefined;
  }
  return normalized;
}
