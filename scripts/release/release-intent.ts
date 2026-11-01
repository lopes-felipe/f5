import {
  parseStableIntent,
  SHA_PATTERN,
  type StableIntent,
  type StableRequest,
} from "./release-candidate.ts";

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
export interface ReleaseWithdrawal {
  readonly action: "withdraw";
  readonly requestId: string;
  /** Request UUIDs, or exact intent-edit commit SHAs when the edit is malformed. */
  readonly withdraws: readonly string[];
  readonly reason: string;
}
export type ReleaseIntent = StableIntent | ReleaseWithdrawal;
export function parseReleaseIntent(value: unknown): ReleaseIntent {
  if (value && typeof value === "object" && "action" in value) {
    const withdrawal = value as ReleaseWithdrawal;
    if (
      withdrawal.action !== "withdraw" ||
      !UUID.test(withdrawal.requestId) ||
      !Array.isArray(withdrawal.withdraws) ||
      !withdrawal.withdraws.length ||
      withdrawal.withdraws.some(
        (id) =>
          typeof id !== "string" ||
          (!UUID.test(id) && !SHA_PATTERN.test(id)) ||
          id === withdrawal.requestId,
      ) ||
      typeof withdrawal.reason !== "string" ||
      !withdrawal.reason.trim()
    )
      throw new Error("Withdrawal requires a UUID, explicit request/commit targets and a reason");
    return {
      action: "withdraw",
      requestId: withdrawal.requestId,
      withdraws: [...new Set(withdrawal.withdraws)].sort(),
      reason: withdrawal.reason.trim(),
    };
  }
  return parseStableIntent(value);
}

/** Reverts never repin a request. Explicit withdrawals can repair invalid historical edits. */
export function resolveStableHistory(
  snapshots: readonly { sourceSha: string; text: string | undefined }[],
): StableRequest[] {
  const parsed = snapshots.map((snapshot) => {
    try {
      if (!snapshot.text) throw new Error("Stable release intent was removed");
      return { ...snapshot, intent: parseReleaseIntent(JSON.parse(snapshot.text)), error: null };
    } catch (error) {
      return { ...snapshot, intent: null, error };
    }
  });
  const withdrawn = new Set<string>();
  const withdrawalErrors = new Map<string, Error>();
  // A later explicit repair may withdraw an invalid withdrawal as well.
  for (let index = parsed.length - 1; index >= 0; index--) {
    const snapshot = parsed[index]!;
    if (
      !snapshot.intent ||
      !("action" in snapshot.intent) ||
      withdrawn.has(snapshot.sourceSha) ||
      withdrawn.has(snapshot.intent.requestId)
    )
      continue;
    const known = new Set(
      parsed
        .slice(0, index)
        .flatMap((s) => [s.sourceSha, ...(s.intent ? [s.intent.requestId] : [])]),
    );
    for (const id of snapshot.intent.withdraws) {
      if (!known.has(id))
        withdrawalErrors.set(
          snapshot.sourceSha,
          new Error("Withdrawal target is not in prior intent history: " + id),
        );
      else withdrawn.add(id);
    }
  }
  const requests = parsed.flatMap((s) =>
    s.intent && !("action" in s.intent) ? [{ ...s.intent, sourceSha: s.sourceSha }] : [],
  );
  // Withdrawing a recovery withdraws its whole lineage; an old pin must never revive.
  for (let changed = true; changed; ) {
    changed = false;
    for (const request of requests) {
      const targets = [
        request.requestId,
        request.sourceSha,
        ...(request.supersedes ? [request.supersedes] : []),
      ];
      if (!targets.some((id) => withdrawn.has(id))) continue;
      for (const id of targets)
        if (!withdrawn.has(id)) {
          withdrawn.add(id);
          changed = true;
        }
    }
  }
  const seen = new Map<string, ReleaseIntent>();
  const result: StableRequest[] = [];
  for (const snapshot of parsed) {
    if (withdrawn.has(snapshot.sourceSha)) continue;
    if (withdrawalErrors.has(snapshot.sourceSha)) throw withdrawalErrors.get(snapshot.sourceSha)!;
    if (snapshot.error)
      throw new Error("Invalid release intent at " + snapshot.sourceSha, { cause: snapshot.error });
    const intent = snapshot.intent!;
    if (withdrawn.has(intent.requestId)) continue;
    const previous = seen.get(intent.requestId);
    if (previous) {
      if (JSON.stringify(previous) !== JSON.stringify(intent))
        throw new Error("Stable request ID reused with different intent: " + intent.requestId);
      continue;
    }
    seen.set(intent.requestId, intent);
    if (!("action" in intent)) result.push({ ...intent, sourceSha: snapshot.sourceSha });
  }
  return result;
}
