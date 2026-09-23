import { Data, ServiceMap } from "effect";
import type { Effect } from "effect";

export class SecretStoreError extends Data.TaggedError("SecretStoreError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export interface ServerSecretStoreShape {
  readonly get: (name: string) => Effect.Effect<Uint8Array | null, SecretStoreError>;
  readonly set: (name: string, value: Uint8Array) => Effect.Effect<void, SecretStoreError>;
  /**
   * Atomically publishes a complete secret without replacing a concurrent winner.
   * Requires hard-link support in secretsDir; unsupported filesystems fail with
   * SecretStoreError rather than falling back to a partially visible write.
   * File contents are synced, but directory entries are not power-loss durable.
   */
  readonly getOrCreateRandom: (
    name: string,
    bytes: number,
  ) => Effect.Effect<Uint8Array, SecretStoreError>;
  readonly remove: (name: string) => Effect.Effect<void, SecretStoreError>;
}

export class ServerSecretStore extends ServiceMap.Service<
  ServerSecretStore,
  ServerSecretStoreShape
>()("t3/auth/Services/ServerSecretStore") {}
