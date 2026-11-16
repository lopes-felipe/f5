import type { McpConfigIssue, McpProjectServersConfig } from "@t3tools/contracts";
import {
  mcpSecretId,
  mcpSecretReferences,
  validateMcpSecretPlaceholders,
} from "@t3tools/shared/mcpSecrets";
import { Data, Effect } from "effect";
import type { ServerSecretStoreShape } from "../auth/Services/ServerSecretStore.ts";

class McpSecretValidationError extends Data.TaggedError("McpSecretValidationError")<{
  message: string;
}> {}

export function resolveMcpSecrets(
  servers: McpProjectServersConfig,
  store: ServerSecretStoreShape | undefined,
) {
  return Effect.gen(function* () {
    const resolved: Record<string, McpProjectServersConfig[string]> = {};
    const issues: McpConfigIssue[] = [];
    const valuesById = new Map<string, string | null>();
    for (const [name, server] of Object.entries(servers)) {
      let missing = false;
      const next = { ...server };
      try {
        validateMcpSecretPlaceholders({ [name]: server });
      } catch {
        missing = true;
      }
      for (const field of ["env", "headers"] as const) {
        if (!server[field]) continue;
        const values = { ...server[field] };
        for (const [key, value] of Object.entries(values)) {
          const id = mcpSecretId(value);
          if (!id) continue;
          if (!valuesById.has(id)) {
            const bytes = store
              ? yield* store.get(`mcp-secret-${id}`).pipe(Effect.catch(() => Effect.succeed(null)))
              : null;
            valuesById.set(id, bytes ? new TextDecoder().decode(bytes) : null);
          }
          const secretValue = valuesById.get(id);
          if (secretValue === null || secretValue === undefined) missing = true;
          else values[key] = secretValue;
        }
        next[field] = values;
      }
      if (missing)
        issues.push({
          kind: "validation",
          serverName: name,
          message:
            "A stored secret is missing or invalid. This server was skipped. Replace the secret in F5 MCP settings.",
        });
      else resolved[name] = next;
    }
    return { servers: resolved, issues };
  });
}

export function validateStoredMcpSecrets(
  servers: McpProjectServersConfig,
  store: ServerSecretStoreShape | undefined,
  base: McpProjectServersConfig = {},
) {
  return Effect.gen(function* () {
    yield* Effect.try({
      try: () => validateMcpSecretPlaceholders(servers),
      catch: (error) =>
        new McpSecretValidationError({
          message: error instanceof Error ? error.message : "Invalid MCP secret placeholder.",
        }),
    });
    for (const [name, server] of Object.entries(servers)) {
      for (const field of ["env", "headers"] as const) {
        for (const [key, value] of Object.entries(server[field] ?? {})) {
          const id = mcpSecretId(value);
          // An unchanged reference may be unavailable after a restore. Keep repair and unrelated edits possible.
          if (!id || base[name]?.[field]?.[key] === value) continue;
          const bytes = store ? yield* store.get(`mcp-secret-${id}`) : null;
          if (!bytes)
            return yield* Effect.fail(
              new McpSecretValidationError({
                message: `${name}.${field}.${key}: stored secret is missing. Replace it before saving.`,
              }),
            );
        }
      }
    }
  });
}

export function collectMcpSecrets(
  store: ServerSecretStoreShape,
  servers: McpProjectServersConfig,
  now = Date.now(),
) {
  const referenced = mcpSecretReferences(servers);
  return Effect.gen(function* () {
    const entries = yield* store.list("mcp-secret-");
    for (const entry of entries) {
      if (
        !referenced.has(entry.name.slice("mcp-secret-".length)) &&
        now - entry.modifiedAt > 24 * 60 * 60 * 1000
      )
        yield* store.remove(entry.name);
    }
  });
}
