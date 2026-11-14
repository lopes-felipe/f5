import {
  AccountUsageSection,
  type AccountUsageErrorCode,
  type UsageAccount,
} from "@t3tools/contracts";
import { quotaWindowsFromSection } from "@t3tools/shared/usageLimit";
import { Cause, Effect, Option, Schema } from "effect";
import * as Semaphore from "effect/Semaphore";
import { createHmac, randomBytes } from "node:crypto";

import { ServerSecretStore } from "../auth/Services/ServerSecretStore.ts";
import { UsageAccountHistoryRepository } from "../persistence/Services/UsageAccountHistory.ts";

type Snapshot = NonNullable<AccountUsageSection["snapshot"]>;

interface PersistedSection {
  readonly identity: string;
  readonly fetchedAt: string;
  readonly section: AccountUsageSection;
}

const NON_HYDRATABLE: ReadonlyArray<AccountUsageErrorCode> = [
  "authentication-required",
  "unsupported",
];

const decodeSection = Schema.decodeUnknownOption(AccountUsageSection);

const sectionKey = (accountKey: string, kind: string) => `${accountKey}\u0000${kind}`;

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
}

function clearsPersistedSnapshot(section: AccountUsageSection): boolean {
  return (
    section.outcome === "unsupported" ||
    section.errorCode === "authentication-required" ||
    section.errorCode === "unsupported"
  );
}

export interface AccountHistoryRecorder {
  /** Persists newer available snapshots and quota samples; never fails. */
  readonly observe: (account: UsageAccount, identity: string) => Effect.Effect<void>;
  /**
   * Fills unavailable, never-loaded sections from persisted snapshots. A null
   * identity (shadow accounts) accepts any persisted identity.
   */
  readonly hydrate: (account: UsageAccount, identity: string | null) => UsageAccount;
}

// Used only when protected secret storage is unavailable (e.g. tests): history
// then matches within this process but not across restarts.
const processIdentityKey = randomBytes(32);
const IDENTITY_KEY_SECRET = "usage-account-identity-key";

/**
 * Loads the per-install key for persisted account identities. Identities can
 * derive from credentials, so stored values are keyed HMACs rather than plain
 * digests that could be checked against guessed secrets offline.
 */
const loadIdentityKey = Effect.gen(function* () {
  const store = yield* Effect.serviceOption(ServerSecretStore);
  if (Option.isNone(store)) return processIdentityKey;
  return yield* store.value
    .getOrCreateRandom(IDENTITY_KEY_SECRET, 32)
    .pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning(
          "Usage identity key unavailable; account history will not survive a restart",
          Cause.pretty(cause),
        ).pipe(Effect.as(processIdentityKey)),
      ),
    );
});

export const makeAccountHistoryRecorder = Effect.gen(function* () {
  const repository = yield* UsageAccountHistoryRepository;
  const identityKey = yield* loadIdentityKey;
  const protect = (identity: string) =>
    `hmac:${createHmac("sha256", identityKey).update(identity).digest("hex")}`;
  const lock = yield* Semaphore.make(1);
  const persisted = new Map<string, PersistedSection>();

  const rows = yield* repository.listSnapshots.pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning(
        "Failed to load persisted account usage snapshots",
        Cause.pretty(cause),
      ).pipe(Effect.as([])),
    ),
  );
  for (const row of rows) {
    const data = parseJson(row.dataJson);
    if (data === undefined) continue;
    const decoded = decodeSection({
      kind: row.sectionKind,
      outcome: "available",
      lastAttemptAt: null,
      errorCode: null,
      snapshot: { fetchedAt: row.fetchedAt, data },
    });
    if (Option.isNone(decoded)) continue;
    persisted.set(sectionKey(row.accountKey, row.sectionKind), {
      identity: row.identity,
      fetchedAt: row.fetchedAt,
      section: decoded.value,
    });
  }

  const observe: AccountHistoryRecorder["observe"] = (account, accountIdentity) => {
    const identity = protect(accountIdentity);
    return lock
      .withPermits(1)(
        Effect.gen(function* () {
          const writes: Array<{
            readonly section: AccountUsageSection;
            readonly snapshot: Snapshot;
          }> = [];
          const deletes: Array<string> = [];
          for (const section of account.sections) {
            const prior = persisted.get(sectionKey(account.key, section.kind));
            if (section.outcome === "available" && section.snapshot) {
              if (
                !prior ||
                prior.identity !== identity ||
                section.snapshot.fetchedAt > prior.fetchedAt
              )
                writes.push({ section, snapshot: section.snapshot });
            } else if (prior && clearsPersistedSnapshot(section)) {
              deletes.push(section.kind);
            }
          }
          if (writes.length > 0) {
            yield* repository.recordObservation({
              accountKey: account.key,
              identity,
              snapshots: writes.map(({ section, snapshot }) => ({
                sectionKind: section.kind,
                fetchedAt: snapshot.fetchedAt,
                dataJson: JSON.stringify(snapshot.data),
              })),
              samples: writes.flatMap(({ section, snapshot }) =>
                quotaWindowsFromSection(section).flatMap((window) =>
                  window.usedPercent === null
                    ? []
                    : [
                        {
                          windowKey: window.windowKey,
                          sampledAt: snapshot.fetchedAt,
                          usedPercent: window.usedPercent,
                          resetsAt: window.resetsAt,
                        },
                      ],
                ),
              ),
            });
            // The watermark advances only after commit. The transaction dropped
            // rows recorded under another identity, so mirror that here.
            for (const [key, entry] of persisted) {
              if (key.startsWith(`${account.key}\u0000`) && entry.identity !== identity)
                persisted.delete(key);
            }
            for (const { section, snapshot } of writes) {
              const key = sectionKey(account.key, section.kind);
              const current = persisted.get(key);
              if (
                current &&
                current.identity === identity &&
                current.fetchedAt >= snapshot.fetchedAt
              )
                continue;
              persisted.set(key, { identity, fetchedAt: snapshot.fetchedAt, section });
            }
          }
          for (const kind of deletes) {
            yield* repository.deleteSnapshot(account.key, kind);
            persisted.delete(sectionKey(account.key, kind));
          }
        }),
      )
      .pipe(
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.failCause(cause as Cause.Cause<never>)
            : Effect.logWarning("Failed to persist account usage history", Cause.pretty(cause)),
        ),
      );
  };

  const hydrate: AccountHistoryRecorder["hydrate"] = (account, identity) => ({
    ...account,
    sections: account.sections.map((section) => {
      if (
        section.outcome !== "unavailable" ||
        section.snapshot !== null ||
        (section.errorCode !== null && NON_HYDRATABLE.includes(section.errorCode))
      )
        return section;
      const stored = persisted.get(sectionKey(account.key, section.kind));
      if (!stored || stored.section.kind !== section.kind) return section;
      if (identity !== null && stored.identity !== protect(identity)) return section;
      // Stale credits and limit resets must never drive the reset-credit control.
      const snapshot =
        stored.section.kind === "codex-limits" && stored.section.snapshot
          ? {
              ...stored.section.snapshot,
              data: { ...stored.section.snapshot.data, resetCredits: null },
            }
          : stored.section.kind === "claude-usage" && stored.section.snapshot
            ? {
                ...stored.section.snapshot,
                data: { ...stored.section.snapshot.data, limitResets: null },
              }
            : stored.section.snapshot;
      return { ...section, snapshot } as AccountUsageSection;
    }),
  });

  return { observe, hydrate } satisfies AccountHistoryRecorder;
});
