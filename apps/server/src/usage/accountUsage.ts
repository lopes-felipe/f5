import type { UsageAccount, UsageGetAccountsInput } from "@t3tools/contracts";
import { createHash } from "node:crypto";
import type { Effect } from "effect";
import type * as Semaphore from "effect/Semaphore";

export const ACCOUNT_ATTEMPT_TTL_MS = 5 * 60_000;
export interface AccountUsageCapability {
  /** sha256-derived account configuration identity; never a raw secret. */
  readonly identity: string;
  readonly getSnapshot: Effect.Effect<UsageAccount>;
  readonly refreshAccount?: (
    permits: Semaphore.Semaphore,
    mode?: "force" | "if-stale",
  ) => Effect.Effect<{ snapshot: UsageAccount; fresh: boolean; nextAllowedAt?: string }>;
  readonly refresh: (
    mode: UsageGetAccountsInput["refresh"],
    permits: Semaphore.Semaphore,
  ) => Effect.Effect<void>;
  /** Drops cached reads so the next refresh probes again. */
  readonly invalidate?: Effect.Effect<void>;
}

/** Hashes configuration inputs into a stable, secret-free account identity. */
export function accountUsageIdentity(
  prefix: string,
  inputs: ReadonlyArray<string | null | undefined>,
): string {
  return `${prefix}:${createHash("sha256")
    .update(JSON.stringify(inputs.map((input) => input ?? null)))
    .digest("hex")}`;
}
