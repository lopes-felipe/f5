import type { McpProjectServersConfig, McpServerDefinition } from "@t3tools/contracts";

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const SECRET = new RegExp(`^\\$\\{f5-secret:(${UUID})\\}$`);
const SECRET_REFERENCE = new RegExp(`\\$\\{f5-secret:(${UUID})\\}`, "g");

/** Fields whose values may contain `${f5-secret:…}` references. */
export const MCP_SECRET_FIELDS = ["env", "headers", "args", "url"] as const;

/** The secret id when `value` is exactly one reference (shown as a stored secret in settings). */
export function mcpSecretId(value: string): string | undefined {
  return SECRET.exec(value)?.[1];
}

/** Every secret id referenced anywhere in `value`. */
export function mcpSecretIds(value: string): string[] {
  return [...value.matchAll(SECRET_REFERENCE)].map((match) => match[1]!);
}

/** The reference text for a stored secret id. */
export function mcpSecretReference(id: string): string {
  return `\${f5-secret:${id}}`;
}

/** Replaces each reference with its value; `undefined` from `lookup` leaves the reference. */
export function replaceMcpSecretReferences(
  value: string,
  lookup: (id: string) => string | undefined,
): string {
  return value.replace(SECRET_REFERENCE, (reference, id: string) => lookup(id) ?? reference);
}

/** The strings of a server that may hold references, keyed for error messages. */
export function mcpSecretFieldValues(
  server: McpServerDefinition,
): Array<{ readonly field: string; readonly value: string }> {
  const values: Array<{ field: string; value: string }> = [];
  for (const [key, value] of Object.entries(server.env ?? {}))
    values.push({ field: `env.${key}`, value });
  for (const [key, value] of Object.entries(server.headers ?? {}))
    values.push({ field: `headers.${key}`, value });
  (server.args ?? []).forEach((value, index) => values.push({ field: `args.${index}`, value }));
  if (server.url) values.push({ field: "url", value: server.url });
  return values;
}

export function mcpSecretReferences(servers: McpProjectServersConfig): Set<string> {
  const ids = new Set<string>();
  for (const server of Object.values(servers))
    for (const { value } of mcpSecretFieldValues(server))
      for (const id of mcpSecretIds(value)) ids.add(id);
  return ids;
}

/**
 * References may appear in env and header values, arguments and URLs, alone or
 * inside a longer value (`Bearer ${f5-secret:…}`). Every `${f5-secret:` must start
 * a well-formed reference, and no other field may contain one.
 */
export function validateMcpSecretPlaceholders(servers: McpProjectServersConfig): void {
  for (const [name, server] of Object.entries(servers)) {
    for (const [field, value] of Object.entries(server)) {
      if ((MCP_SECRET_FIELDS as ReadonlyArray<string>).includes(field)) continue;
      if (JSON.stringify(value)?.includes("${f5-secret:"))
        throw new Error(
          `${name}.${field}: secret references are allowed only in env and header values, arguments and URLs.`,
        );
    }
    for (const { field, value } of mcpSecretFieldValues(server))
      if (value.replace(SECRET_REFERENCE, "").includes("${f5-secret:"))
        throw new Error(`${name}.${field}: a secret reference must contain a valid secret id.`);
  }
}
