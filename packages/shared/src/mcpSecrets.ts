import type { McpProjectServersConfig } from "@t3tools/contracts";

const SECRET = /^\$\{f5-secret:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\}$/;
export function mcpSecretId(value: string): string | undefined {
  return SECRET.exec(value)?.[1];
}
export function mcpSecretReferences(servers: McpProjectServersConfig): Set<string> {
  const ids = new Set<string>();
  for (const server of Object.values(servers)) {
    for (const values of [server.env, server.headers])
      for (const value of Object.values(values ?? {})) {
        const id = mcpSecretId(value);
        if (id) ids.add(id);
      }
  }
  return ids;
}
export function validateMcpSecretPlaceholders(servers: McpProjectServersConfig): void {
  for (const [name, server] of Object.entries(servers)) {
    for (const [field, value] of Object.entries(server)) {
      if (field === "env" || field === "headers") {
        for (const entry of Object.values(value ?? {}))
          if (typeof entry === "string" && entry.includes("${f5-secret:") && !mcpSecretId(entry))
            throw new Error(
              `${name}.${field}: a secret placeholder must be the entire value and contain a valid UUID.`,
            );
      } else if (JSON.stringify(value)?.includes("${f5-secret:"))
        throw new Error(
          `${name}.${field}: secret placeholders are allowed only in env and header values.`,
        );
    }
  }
}
