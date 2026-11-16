import { Effect, Semaphore, Data } from "effect";
import type { ServerSecretStoreShape } from "../auth/Services/ServerSecretStore.ts";

class McpSecretWriteError extends Data.TaggedError("McpSecretWriteError")<{ message: string }> {}

/** Bound the entire MCP secret directory, including orphaned writes, across concurrent clients. */
export const makeMcpSecretWriter = (store: ServerSecretStoreShape, limit = 4096) =>
  Effect.gen(function* () {
    const lock = yield* Semaphore.make(1);
    return (value: string) =>
      lock
        .withPermits(1)(
          Effect.gen(function* () {
            if (Buffer.byteLength(value, "utf8") > 16384)
              return yield* new McpSecretWriteError({ message: "Secrets must be at most 16 KiB." });
            const entries = yield* store.list("mcp-secret-");
            if (entries.length >= limit)
              return yield* new McpSecretWriteError({
                message:
                  "MCP secret storage limit reached. Remove unused secret files or restart to collect unreferenced secrets older than 24 hours.",
              });
            const id = crypto.randomUUID();
            yield* store.set(`mcp-secret-${id}`, new TextEncoder().encode(value));
            return { placeholder: "${f5-secret:" + id + "}" };
          }),
        )
        .pipe(
          Effect.mapError(
            (error) =>
              new McpSecretWriteError({
                message:
                  error instanceof McpSecretWriteError
                    ? error.message
                    : "Could not store the secret.",
              }),
          ),
        );
  });
