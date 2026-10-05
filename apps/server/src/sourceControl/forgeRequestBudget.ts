import { createHash } from "node:crypto";
import { Semaphore } from "effect";
import type { ForgeAccount } from "./ForgeSourceControlProvider.ts";

interface RequestBudget {
  readonly gate: Semaphore.Semaphore;
  blockedUntil: number;
  users: number;
}

// Shared by provider instances, including the PR hub and GitManager. Secret rotation
// creates a separate budget without retaining the secret itself.
const budgets = new Map<string, RequestBudget>();
const MAX_IDENTITIES = 128;

export function forgeRequestBudget(account: ForgeAccount): RequestBudget | undefined {
  const identity = JSON.stringify([
    account.kind,
    account.host.toLowerCase(),
    account.login,
    createHash("sha256").update(account.token).digest("hex"),
  ]);
  let budget = budgets.get(identity);
  if (!budget) {
    if (budgets.size >= MAX_IDENTITIES) {
      const idle = [...budgets].find(
        ([, value]) => value.users === 0 && value.blockedUntil <= Date.now(),
      );
      if (!idle) return undefined;
      budgets.delete(idle[0]);
    }
    budget = { gate: Semaphore.makeUnsafe(4), blockedUntil: 0, users: 0 };
    budgets.set(identity, budget);
  }
  return budget;
}

export function updateForgeRequestBudget(budget: RequestBudget, response: Response): void {
  const now = Date.now();
  const retry = response.headers.get("retry-after");
  const retryAt = retry
    ? /^\d+(?:\.\d+)?$/.test(retry)
      ? now + Number(retry) * 1000
      : Date.parse(retry)
    : NaN;
  const reset =
    response.headers.get("ratelimit-reset") ?? response.headers.get("x-ratelimit-reset");
  const resetAt = reset ? Number(reset) * 1000 : NaN;
  const remaining =
    response.headers.get("ratelimit-remaining") ?? response.headers.get("x-ratelimit-remaining");
  if (response.status === 429 || remaining === "0") {
    const until = Math.max(
      now + 1000,
      Number.isFinite(retryAt) ? retryAt : 0,
      Number.isFinite(resetAt) ? resetAt : 0,
    );
    // A 429 without timing information still prevents repeated optional reads.
    budget.blockedUntil = Math.max(
      budget.blockedUntil,
      Number.isFinite(retryAt) || Number.isFinite(resetAt) ? until : now + 60_000,
    );
  }
}
