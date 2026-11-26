import type { McpConfigIssue, McpProjectServersConfig } from "@t3tools/contracts";
import {
  mcpSecretFieldValues,
  mcpSecretIds,
  mcpSecretReferences,
  replaceMcpSecretReferences,
  validateMcpSecretPlaceholders,
} from "@t3tools/shared/mcpSecrets";
import { Data, Effect } from "effect";
import type { ServerSecretStoreShape } from "../auth/Services/ServerSecretStore.ts";
import { rememberResolvedMcpField, rememberResolvedMcpSecret } from "./mcpResolvedSecrets.ts";

class McpSecretValidationError extends Data.TaggedError("McpSecretValidationError")<{
  message: string;
}> {}

/**
 * Replaces `${f5-secret:…}` references in env and header values, arguments and URLs
 * with the stored values. A server with a missing secret is skipped with an issue.
 */
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
      try {
        validateMcpSecretPlaceholders({ [name]: server });
      } catch {
        missing = true;
      }
      for (const { value } of mcpSecretFieldValues(server))
        for (const id of mcpSecretIds(value)) {
          if (valuesById.has(id)) continue;
          const bytes = store
            ? yield* store.get(`mcp-secret-${id}`).pipe(Effect.catch(() => Effect.succeed(null)))
            : null;
          const secret = bytes ? new TextDecoder().decode(bytes) : null;
          if (secret !== null) rememberResolvedMcpSecret(secret);
          valuesById.set(id, secret);
        }
      const lookup = (id: string) => {
        const secret = valuesById.get(id);
        if (secret === null || secret === undefined) {
          missing = true;
          return undefined;
        }
        return secret;
      };
      const replace = (value: string, encode = false) => {
        const next = replaceMcpSecretReferences(value, (id) => {
          const secret = lookup(id);
          // A secret in a URL is encoded, so `/ ? # @` in it cannot change the URL's parts.
          return secret === undefined || !encode ? secret : encodeURIComponent(secret);
        });
        if (next !== value) rememberResolvedMcpField(next);
        return next;
      };
      const replaceRecord = (values: Record<string, string> | undefined) =>
        values
          ? Object.fromEntries(Object.entries(values).map(([key, value]) => [key, replace(value)]))
          : undefined;
      const next = {
        ...server,
        ...(server.env ? { env: replaceRecord(server.env) } : {}),
        ...(server.headers ? { headers: replaceRecord(server.headers) } : {}),
        ...(server.args ? { args: server.args.map((arg) => replace(arg)) } : {}),
        ...(server.url ? { url: replace(server.url, true) } : {}),
      } as McpProjectServersConfig[string];
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
      // An unchanged reference may be unavailable after a restore. Keep repair and unrelated edits possible.
      const previous = new Map(
        (base[name] ? mcpSecretFieldValues(base[name]) : []).map(({ field, value }) => [
          field,
          value,
        ]),
      );
      for (const { field, value } of mcpSecretFieldValues(server)) {
        if (previous.get(field) === value) continue;
        for (const id of mcpSecretIds(value)) {
          const bytes = store ? yield* store.get(`mcp-secret-${id}`) : null;
          if (!bytes)
            return yield* Effect.fail(
              new McpSecretValidationError({
                message: `${name}.${field}: stored secret is missing. Replace it before saving.`,
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
