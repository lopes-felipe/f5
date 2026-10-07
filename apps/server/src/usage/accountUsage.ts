import type { UsageAccount, UsageGetAccountsInput } from "@t3tools/contracts";
import type { Effect } from "effect";
import type * as Semaphore from "effect/Semaphore";

export const ACCOUNT_ATTEMPT_TTL_MS = 5 * 60_000;
export interface AccountUsageCapability {
  readonly getSnapshot: Effect.Effect<UsageAccount>;
  readonly refreshAccount?: (
    permits: Semaphore.Semaphore,
  ) => Effect.Effect<{ snapshot: UsageAccount; fresh: boolean; nextAllowedAt?: string }>;
  readonly refresh: (
    mode: UsageGetAccountsInput["refresh"],
    permits: Semaphore.Semaphore,
  ) => Effect.Effect<void>;
}
