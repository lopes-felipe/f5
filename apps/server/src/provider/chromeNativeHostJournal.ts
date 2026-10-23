import { randomUUID } from "node:crypto";
import {
  parseNativeHostManifest,
  sha256,
  type ChromeNativeHostRegistration,
  type ChromeProvider,
} from "./chromeNativeHost";

/**
 * Journal v2. Everything needed to undo a launch is persisted before the CLI starts:
 * identity, the record, immutable restoration slots (original bytes, mode or absence)
 * and predecessor links. Post-launch hashes and per-artifact outcomes follow. Restore
 * reads only this journal and the slot files, so it survives restarts, SDK upgrades
 * and retired records.
 */
export type ChromeTransactionState =
  | "approved"
  | "launched"
  | "restoring"
  | "partially-restored"
  | "restored"
  | "recovery-required";

export interface ChromeArtifactSlot {
  readonly kind: "manifest" | "wrapper";
  readonly browser: string;
  readonly location: string;
  readonly originalBytes: string | null;
  readonly originalHash: string | null;
  readonly originalMode?: number;
  /** Newest earlier unresolved transaction in this profile that owned the same path. */
  readonly predecessor?: string;
  readonly postLaunchHash?: string;
  readonly outcome?: "restoring" | "restored" | "skipped" | "unresolved";
  /** Persisted before a restoration write; reconciled after a crash. */
  readonly intent?: { readonly expectedHash: string | null; readonly desiredHash: string | null };
}

export interface ChromeNativeHostTransaction {
  readonly version: 2;
  readonly id: string;
  readonly provider: ChromeProvider;
  readonly profileId: string;
  readonly providerInstanceId: string;
  readonly recordId: string;
  readonly evidenceId?: string;
  readonly sdkVersion?: string;
  readonly executablePath?: string;
  readonly providerHome: string;
  readonly userHome: string;
  readonly targetPath: string;
  readonly createdAt: string;
  readonly state: ChromeTransactionState;
  /** Only a verified launch can supply reusable accepted setup. */
  readonly launchVerified?: boolean;
  readonly launchSnapshot?: ReadonlyArray<Omit<ChromeNativeHostRegistration, "bytes">>;
  readonly acceptedForeign: ReadonlyArray<{ readonly location: string; readonly sha256: string }>;
  readonly slots: ReadonlyArray<ChromeArtifactSlot>;
  /** Converted from a v1 journal: only provable slots are restorable. */
  readonly legacy?: boolean;
}

export interface ChromeArtifactRead {
  readonly bytes: string | null;
  readonly mode?: number;
}
export interface ChromeJournalStorage {
  /** Storages sharing a key (one profile state dir) share one write queue. */
  readonly lockKey?: string;
  readonly inspect: () => Promise<ReadonlyArray<ChromeNativeHostRegistration>>;
  readonly saveTransaction: (transaction: ChromeNativeHostTransaction) => Promise<void>;
  readonly loadTransaction: (
    provider: ChromeProvider,
    id: string,
  ) => Promise<ChromeNativeHostTransaction | undefined>;
  readonly listTransactions: (
    provider: ChromeProvider,
  ) => Promise<ReadonlyArray<ChromeNativeHostTransaction>>;
  /** null means positively absent; unreadable throws. */
  readonly readArtifact: (location: string) => Promise<ChromeArtifactRead>;
  /** Atomic write, or removal when bytes is null. */
  readonly writeArtifact: (location: string, bytes: string | null, mode?: number) => Promise<void>;
}

export class ChromeLaunchTimeout extends Error {
  constructor(readonly transaction: ChromeNativeHostTransaction) {
    super("Claude in Chrome did not finish its browser setup in time.");
    this.name = "ChromeLaunchTimeout";
  }
}
export class ChromeRestoreBlocked extends Error {
  constructor(readonly blockingTransactionId: string) {
    super("A newer browser setup uses the same files. Restore it first.");
    this.name = "ChromeRestoreBlocked";
  }
}

export interface ChromeRestoreResult {
  readonly transaction: ChromeNativeHostTransaction;
  readonly restored: ReadonlyArray<string>;
  readonly skipped: ReadonlyArray<string>;
  readonly unresolved: ReadonlyArray<string>;
}

const hashOf = (bytes: string | null) => (bytes === null ? null : sha256(bytes));
const unresolvedState = (state: ChromeTransactionState) => state !== "restored";

/**
 * The oldest newer, unresolved transaction of the same profile that still owns an
 * artifact `candidate` would restore. The settings summary and restore both use this.
 */
export function restoreBlocker(
  candidate: ChromeNativeHostTransaction,
  all: ReadonlyArray<ChromeNativeHostTransaction>,
): string | undefined {
  if (!unresolvedState(candidate.state)) return undefined;
  const locations = new Set(candidate.slots.map((slot) => slot.location));
  return all
    .filter(
      (entry) =>
        entry.id !== candidate.id &&
        entry.profileId === candidate.profileId &&
        unresolvedState(entry.state) &&
        entry.createdAt > candidate.createdAt &&
        entry.slots.some((slot) => locations.has(slot.location) && slot.outcome !== "restored"),
    )
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0]?.id;
}
const snapshot = (entries: ReadonlyArray<ChromeNativeHostRegistration>) =>
  entries.map(({ bytes: _bytes, ...entry }) => entry);

const work = new Map<unknown, Promise<unknown>>();
/** All journal and restoration writes for one storage (or lock key) run behind one queue. */
function serialize<A>(storage: ChromeJournalStorage, task: () => Promise<A>): Promise<A> {
  const key = storage.lockKey ?? storage;
  const result = (work.get(key) ?? Promise.resolve()).then(task);
  const tail = result.then(
    () => undefined,
    () => undefined,
  );
  work.set(key, tail);
  void tail.then(() => {
    if (work.get(key) === tail) work.delete(key);
  });
  return result;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export class ChromeNativeHostTransactions {
  constructor(private readonly storage: ChromeJournalStorage) {}

  approve(input: {
    provider: ChromeProvider;
    profileId: string;
    providerInstanceId: string;
    recordId: string;
    evidenceId?: string;
    sdkVersion?: string;
    executablePath?: string;
    providerHome: string;
    userHome: string;
    targetPath: string;
    /** Wrapper slot for CLI-owned registrations; external owners have none. */
    wrapperLocation?: string;
    observed: ReadonlyArray<ChromeNativeHostRegistration>;
    acceptedForeign: ReadonlyArray<{ readonly location: string; readonly sha256: string }>;
  }): Promise<ChromeNativeHostTransaction> {
    return serialize(this.storage, async () => {
      const current = await this.storage.inspect();
      if (
        JSON.stringify(current.map((entry) => [entry.location, entry.sha256, entry.state])) !==
        JSON.stringify(input.observed.map((entry) => [entry.location, entry.sha256, entry.state]))
      )
        throw new Error("Chrome setup changed; fresh consent is required.");
      if (current.some((entry) => entry.state === "unreadable" || entry.state === "malformed"))
        throw new Error("Chrome setup unreadable.");
      const earlier = (await this.storage.listTransactions(input.provider))
        .filter((entry) => entry.profileId === input.profileId && unresolvedState(entry.state))
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      const predecessor = (location: string) =>
        earlier.find((entry) => entry.slots.some((slot) => slot.location === location))?.id;
      const slots: ChromeArtifactSlot[] = [];
      for (const entry of current) {
        const read = await this.storage.readArtifact(entry.location);
        if (read.bytes !== (entry.bytes ?? null))
          throw new Error("Chrome setup changed; fresh consent is required.");
        const previous = predecessor(entry.location);
        slots.push({
          kind: "manifest",
          browser: entry.browser,
          location: entry.location,
          originalBytes: read.bytes,
          originalHash: hashOf(read.bytes),
          ...(read.mode !== undefined ? { originalMode: read.mode } : {}),
          ...(previous ? { predecessor: previous } : {}),
        });
      }
      if (input.wrapperLocation) {
        const read = await this.storage.readArtifact(input.wrapperLocation);
        const previous = predecessor(input.wrapperLocation);
        slots.push({
          kind: "wrapper",
          browser: "wrapper",
          location: input.wrapperLocation,
          originalBytes: read.bytes,
          originalHash: hashOf(read.bytes),
          ...(read.mode !== undefined ? { originalMode: read.mode } : {}),
          ...(previous ? { predecessor: previous } : {}),
        });
      }
      const transaction: ChromeNativeHostTransaction = {
        version: 2,
        id: randomUUID(),
        provider: input.provider,
        profileId: input.profileId,
        providerInstanceId: input.providerInstanceId,
        recordId: input.recordId,
        ...(input.evidenceId ? { evidenceId: input.evidenceId } : {}),
        ...(input.sdkVersion ? { sdkVersion: input.sdkVersion } : {}),
        ...(input.executablePath ? { executablePath: input.executablePath } : {}),
        providerHome: input.providerHome,
        userHome: input.userHome,
        targetPath: input.targetPath,
        createdAt: new Date().toISOString(),
        state: "approved",
        acceptedForeign: input.acceptedForeign,
        slots,
      };
      await this.storage.saveTransaction(transaction);
      return transaction;
    });
  }

  /** Fills post-launch hashes for every artifact that now belongs to this transaction. */
  private async observe(
    transaction: ChromeNativeHostTransaction,
  ): Promise<{ next: ChromeNativeHostTransaction; reads: Map<string, string | null> }> {
    const reads = new Map<string, string | null>();
    const slots: ChromeArtifactSlot[] = [];
    for (const slot of transaction.slots) {
      let bytes: string | null;
      try {
        bytes = (await this.storage.readArtifact(slot.location)).bytes;
      } catch {
        slots.push(slot);
        continue;
      }
      reads.set(slot.location, bytes);
      const hash = hashOf(bytes);
      let next = slot;
      if (slot.intent && slot.outcome === "restoring" && hash === slot.intent.desiredHash) {
        const { intent: _intent, ...rest } = slot;
        next = { ...rest, outcome: "restored" };
      } else if (!slot.postLaunchHash && hash !== null && slot.outcome === undefined) {
        const owned =
          slot.kind === "wrapper"
            ? transaction.state !== "approved" || hash !== slot.originalHash
            : parseNativeHostManifest(slot.browser, slot.location, bytes).targetPath ===
              transaction.targetPath;
        if (owned) next = { ...slot, postLaunchHash: hash };
      }
      slots.push(next);
    }
    return { next: { ...transaction, slots }, reads };
  }

  /**
   * Polls until every certified location points at the wrapper (250 ms, up to 10 s).
   * The partial journal is persisted either way, so a timed-out launch stays restorable.
   */
  recordLaunch(
    transaction: ChromeNativeHostTransaction,
    options: {
      verifyWrapper?: (bytes: string) => Promise<boolean>;
      allowedOrigins?: ReadonlyArray<string>;
      timeoutMs?: number;
      intervalMs?: number;
      signal?: AbortSignal;
    } = {},
  ): Promise<ChromeNativeHostTransaction> {
    const deadline = Date.now() + (options.timeoutMs ?? 10_000);
    const attempt = (): Promise<ChromeNativeHostTransaction | undefined> =>
      serialize(this.storage, async () => {
        const current = await this.storage.inspect();
        const { next, reads } = await this.observe({ ...transaction, state: "launched" });
        const allowed = new Set(options.allowedOrigins ?? []);
        const manifestsReady = current.every(
          (entry) =>
            entry.shadowed ||
            (entry.state === "ok" &&
              entry.targetPath === transaction.targetPath &&
              (!options.allowedOrigins ||
                (entry.allowedOrigins ?? []).every((origin) => allowed.has(origin)))),
        );
        const wrapper = transaction.slots.find((slot) => slot.kind === "wrapper");
        const wrapperBytes = wrapper ? reads.get(wrapper.location) : undefined;
        const wrapperReady =
          !wrapper ||
          (typeof wrapperBytes === "string" &&
            (!options.verifyWrapper || (await options.verifyWrapper(wrapperBytes))));
        const ready = manifestsReady && wrapperReady;
        const saved: ChromeNativeHostTransaction = {
          ...next,
          launchSnapshot: snapshot(current),
          launchVerified: ready,
        };
        if (ready || Date.now() >= deadline || options.signal?.aborted) {
          await this.storage.saveTransaction(saved);
          if (!ready) throw new ChromeLaunchTimeout(saved);
          return saved;
        }
        return undefined;
      });
    const loop = async (): Promise<ChromeNativeHostTransaction> => {
      for (;;) {
        const result = await attempt();
        if (result) return result;
        await sleep(options.intervalMs ?? 250);
      }
    };
    return loop();
  }

  /** Idempotent: run on connection, timeout, finalizers and at server start. */
  reconcile(transaction: ChromeNativeHostTransaction): Promise<ChromeNativeHostTransaction> {
    return serialize(this.storage, async () => {
      const latest =
        (await this.storage.loadTransaction(transaction.provider, transaction.id)) ?? transaction;
      if (latest.state === "restored") return latest;
      const { next } = await this.observe(latest);
      const settled = settleState(next);
      if (JSON.stringify(settled) !== JSON.stringify(latest))
        await this.storage.saveTransaction(settled);
      return settled;
    });
  }

  /**
   * Restores each artifact this transaction still owns. Refuses, before stopping any
   * session or writing, while a newer unresolved transaction in the profile owns an
   * overlapping path. External changes are skipped and stay retryable.
   */
  restore(
    transaction: ChromeNativeHostTransaction,
    options: {
      stopSessions: () => Promise<void>;
      validateSlot: (
        transaction: ChromeNativeHostTransaction,
        slot: ChromeArtifactSlot,
      ) => Promise<boolean>;
    },
  ): Promise<ChromeRestoreResult> {
    const blocker = async (candidate: ChromeNativeHostTransaction) =>
      restoreBlocker(candidate, await this.storage.listTransactions(candidate.provider));
    const run = async (): Promise<ChromeRestoreResult> => {
      const first =
        (await this.storage.loadTransaction(transaction.provider, transaction.id)) ?? transaction;
      if (first.state === "restored")
        return { transaction: first, restored: [], skipped: [], unresolved: [] };
      const blocking = await blocker(first);
      if (blocking) throw new ChromeRestoreBlocked(blocking);
      // Stopping sessions runs their finalizers, which use this queue: stay outside it.
      await options.stopSessions();
      return serialize(this.storage, () =>
        this.restoreArtifacts(transaction, options.validateSlot, blocker),
      );
    };
    return run();
  }

  private async restoreArtifacts(
    transaction: ChromeNativeHostTransaction,
    validateSlot: (
      transaction: ChromeNativeHostTransaction,
      slot: ChromeArtifactSlot,
    ) => Promise<boolean>,
    blocker: (candidate: ChromeNativeHostTransaction) => Promise<string | undefined>,
  ): Promise<ChromeRestoreResult> {
    let current =
      (await this.storage.loadTransaction(transaction.provider, transaction.id)) ?? transaction;
    if (current.state === "restored")
      return { transaction: current, restored: [], skipped: [], unresolved: [] };
    const blocking = await blocker(current);
    if (blocking) throw new ChromeRestoreBlocked(blocking);
    current = (await this.observe(current)).next;
    const restored: string[] = [];
    const skipped: string[] = [];
    const unresolved: string[] = [];
    const save = async (slots: ChromeArtifactSlot[], state: ChromeTransactionState) => {
      current = { ...current, slots, state };
      await this.storage.saveTransaction(current);
    };
    const slots = [...current.slots];
    for (const [index, slot] of slots.entries()) {
      if (slot.outcome === "restored") continue;
      if (!(await validateSlot(current, slot))) {
        slots[index] = { ...slot, outcome: "unresolved" };
        unresolved.push(slot.location);
        continue;
      }
      let bytes: string | null;
      try {
        bytes = (await this.storage.readArtifact(slot.location)).bytes;
      } catch {
        slots[index] = { ...slot, outcome: "skipped" };
        skipped.push(slot.location);
        continue;
      }
      const hash = hashOf(bytes);
      if (hash === slot.originalHash) {
        // Already original (for example after a crash between write and journal update).
        slots[index] = { ...withoutIntent(slot), outcome: "restored" };
        restored.push(slot.location);
        continue;
      }
      const owned =
        slot.postLaunchHash !== undefined &&
        (hash === slot.postLaunchHash ||
          (slot.kind === "manifest" &&
            !current.legacy &&
            parseNativeHostManifest(slot.browser, slot.location, bytes).targetPath ===
              current.targetPath));
      if (!owned) {
        slots[index] = {
          ...withoutIntent(slot),
          outcome: slot.postLaunchHash ? "skipped" : "unresolved",
        };
        (slot.postLaunchHash ? skipped : unresolved).push(slot.location);
        continue;
      }
      slots[index] = {
        ...slot,
        outcome: "restoring",
        intent: { expectedHash: hash, desiredHash: slot.originalHash },
      };
      await save(slots, "restoring");
      // Re-check ownership immediately before the write.
      const again = hashOf((await this.storage.readArtifact(slot.location)).bytes);
      if (again !== hash) {
        slots[index] = { ...withoutIntent(slot), outcome: "skipped" };
        skipped.push(slot.location);
        continue;
      }
      try {
        await this.storage.writeArtifact(slot.location, slot.originalBytes, slot.originalMode);
      } catch (error) {
        await save(slots, "recovery-required");
        throw error;
      }
      slots[index] = { ...withoutIntent(slot), outcome: "restored" };
      restored.push(slot.location);
      await save(slots, "restoring");
    }
    await save(
      slots,
      slots.every((slot) => slot.outcome === "restored") ? "restored" : "partially-restored",
    );
    return { transaction: current, restored, skipped, unresolved };
  }
}

function withoutIntent(slot: ChromeArtifactSlot): ChromeArtifactSlot {
  const { intent: _intent, ...rest } = slot;
  return rest;
}

function settleState(transaction: ChromeNativeHostTransaction): ChromeNativeHostTransaction {
  if (transaction.state !== "restoring" && transaction.state !== "recovery-required")
    return transaction;
  if (transaction.slots.some((slot) => slot.outcome === "restoring")) return transaction;
  return {
    ...transaction,
    state: transaction.slots.every((slot) => slot.outcome === "restored")
      ? "restored"
      : "partially-restored",
  };
}

/** Wrapper missing, or its exec target gone. */
export function isStaleTransaction(
  transaction: ChromeNativeHostTransaction,
  wrapperBytes: string | null | undefined,
  targetExists: boolean | undefined,
): boolean {
  if (transaction.state === "restored") return false;
  const wrapper = transaction.slots.find((slot) => slot.kind === "wrapper");
  if (wrapper && wrapperBytes === null) return true;
  return targetExists === false;
}
