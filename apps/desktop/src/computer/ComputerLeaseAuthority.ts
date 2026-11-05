import type {
  ComputerAuthorization,
  ComputerLeaseHolder,
  ComputerLeaseScope,
} from "@t3tools/contracts";
import { ComputerControlError } from "@t3tools/shared/computerControl";
import {
  COMPUTER_CHROME_APP_IDS,
  computerScopesConflict,
  sameComputerScope,
} from "@t3tools/shared/computerExecution";

export function sameComputerHolder(a: ComputerLeaseHolder, b: ComputerLeaseHolder): boolean {
  return (
    a.profileId === b.profileId &&
    a.threadId === b.threadId &&
    a.sessionGeneration === b.sessionGeneration &&
    a.turnId === b.turnId &&
    a.executionGeneration === b.executionGeneration &&
    a.backend === b.backend &&
    a.policyRevision === b.policyRevision &&
    sameComputerScope(a.scope, b.scope)
  );
}
const sameThread = (
  a: Pick<ComputerAuthorization, "profileId" | "threadId">,
  b: Pick<ComputerAuthorization, "profileId" | "threadId">,
) => a.profileId === b.profileId && a.threadId === b.threadId;
/** A takeover approved by the user but not yet armed: blocks other foreground work, no permit. */
export interface ComputerTakeoverReservation {
  readonly id: number;
  readonly holder: ComputerLeaseHolder;
  readonly appId: string;
}
interface Entry {
  holder: ComputerLeaseHolder;
  lastMutationAt: number;
}
/**
 * Owned by Electron main, shared across every profile and provider. Holds at most one lease
 * per profile+thread: the machine-wide foreground scope, a background app scope, or a takeover
 * (foreground limited to one app). Capable helpers allow several background leases in one app.
 */
export class ComputerLeaseAuthority {
  private entries: Entry[] = [];
  private generation = 0;
  private reservationId = 0;
  private pending: ComputerTakeoverReservation | null = null;
  private readonly listeners = new Set<(holders: ReadonlyArray<ComputerLeaseHolder>) => void>();
  constructor(
    private readonly now: () => number = Date.now,
    private readonly options: { shareApps?: () => boolean } = {},
  ) {}
  holders(): ReadonlyArray<ComputerLeaseHolder> {
    return this.entries.map((entry) => entry.holder);
  }
  pendingTakeover(): ComputerTakeoverReservation | null {
    return this.pending;
  }
  conflictsFor(input: ComputerLeaseHolder): boolean {
    return (
      this.entries.some(
        ({ holder }) =>
          !sameThread(holder, input) && this.scopesConflict(input.scope, holder.scope),
      ) ||
      (!!this.pending &&
        !sameThread(this.pending.holder, input) &&
        this.scopesConflict(input.scope, this.pending.holder.scope))
    );
  }
  scopesConflict(a: ComputerLeaseScope, b: ComputerLeaseScope): boolean {
    return computerScopesConflict(a, b, { shareApps: this.options.shareApps?.() ?? false });
  }
  renewal(input: ComputerLeaseHolder): boolean {
    return this.entries.some(
      ({ holder, lastMutationAt }) =>
        sameThread(holder, input) &&
        holder.sessionGeneration === input.sessionGeneration &&
        holder.turnId === input.turnId &&
        holder.backend === input.backend &&
        holder.policyRevision === input.policyRevision &&
        holder.cooperative === input.cooperative &&
        sameComputerScope(holder.scope, input.scope) &&
        this.now() - lastMutationAt < 60_000,
    );
  }
  idleConflicts(scope: ComputerLeaseScope, idleMs: number): ReadonlyArray<ComputerLeaseHolder> {
    return this.entries
      .filter(
        ({ holder, lastMutationAt }) =>
          holder.scope.kind !== "takeover" &&
          this.scopesConflict(scope, holder.scope) &&
          this.now() - lastMutationAt >= idleMs,
      )
      .map(({ holder }) => holder);
  }
  /** The armed takeover, which blocks every other thread's background mutations. */
  takeover(): ComputerLeaseHolder | undefined {
    return this.entries.find((entry) => entry.holder.scope.kind === "takeover")?.holder;
  }
  /** Resolve the holder a request's authorization names, by exact generation. */
  find(
    auth: Pick<
      ComputerAuthorization,
      "profileId" | "threadId" | "sessionGeneration" | "turnId" | "executionGeneration"
    >,
    scope?: ComputerLeaseScope,
  ): ComputerLeaseHolder | undefined {
    return this.entries.find(
      ({ holder }) =>
        sameThread(holder, auth) &&
        holder.sessionGeneration === auth.sessionGeneration &&
        holder.turnId === auth.turnId &&
        holder.executionGeneration === auth.executionGeneration &&
        (!scope || sameComputerScope(holder.scope, scope)),
    )?.holder;
  }
  acquire(input: ComputerLeaseHolder): ComputerLeaseHolder {
    this.sweep();
    if (input.scope.kind === "takeover")
      throw new ComputerControlError({
        _tag: "Execution",
        message: "A foreground takeover needs approval.",
      });
    const own = this.entries.find(({ holder }) => sameThread(holder, input));
    if (own) {
      const holder = own.holder;
      const sameTurn =
        holder.sessionGeneration === input.sessionGeneration &&
        holder.turnId === input.turnId &&
        holder.backend === input.backend;
      if (
        sameTurn &&
        holder.cooperative === input.cooperative &&
        holder.policyRevision === input.policyRevision &&
        sameComputerScope(holder.scope, input.scope)
      ) {
        own.lastMutationAt = this.now();
        return holder;
      }
      // A scope change keeps the thread's single lease: only within the same session/turn.
      if (!sameTurn) throw this.busy(holder, input.profileId);
    }
    for (const { holder } of this.entries)
      if (!sameThread(holder, input) && this.scopesConflict(input.scope, holder.scope))
        throw this.busy(holder, input.profileId);
    if (this.pending && !sameThread(this.pending.holder, input)) {
      if (input.scope.kind === "foreground" || input.scope.appId === this.pending.appId)
        throw this.busy(this.pending.holder, input.profileId);
    }
    if (own) this.entries = this.entries.filter((entry) => entry !== own);
    const granted = { ...input, executionGeneration: ++this.generation };
    this.entries.push({ holder: granted, lastMutationAt: this.now() });
    this.notify();
    return granted;
  }
  /** Reserve the foreground for one app while the user decides and finishes input. */
  reserveTakeover(input: ComputerLeaseHolder): ComputerTakeoverReservation {
    this.sweep();
    if (input.scope.kind !== "takeover")
      throw new ComputerControlError({ _tag: "Execution", message: "Not a takeover scope." });
    const appId = input.scope.appId;
    if (this.pending) throw this.busy(this.pending.holder, input.profileId);
    for (const { holder } of this.entries)
      if (!sameThread(holder, input) && this.scopesConflict(input.scope, holder.scope))
        throw this.busy(holder, input.profileId);
    this.pending = { id: ++this.reservationId, holder: input, appId };
    this.notify();
    return this.pending;
  }
  cancelTakeover(reservation?: ComputerTakeoverReservation): void {
    if (!this.pending || (reservation && this.pending.id !== reservation.id)) return;
    this.pending = null;
    this.notify();
  }
  /** Arm the reserved takeover. Replaces the thread's own background lease, if any. */
  armTakeover(
    reservation: ComputerTakeoverReservation,
    approvalReceipt: string,
  ): ComputerLeaseHolder {
    if (this.pending?.id !== reservation.id)
      throw new ComputerControlError({ _tag: "Interrupted", cause: "paused" });
    const scope: ComputerLeaseScope = {
      kind: "takeover",
      appId: reservation.appId,
      approvalReceipt,
    };
    for (const { holder } of this.entries)
      if (!sameThread(holder, reservation.holder) && this.scopesConflict(scope, holder.scope))
        throw this.busy(holder, reservation.holder.profileId);
    this.pending = null;
    this.entries = this.entries.filter(({ holder }) => !sameThread(holder, reservation.holder));
    const granted = { ...reservation.holder, scope, executionGeneration: ++this.generation };
    this.entries.push({ holder: granted, lastMutationAt: this.now() });
    this.notify();
    return granted;
  }
  /** The holder that blocks a Chrome lease for `profileId`, same-profile holders first. */
  chromeConflict(profileId: string): ComputerLeaseHolder | null {
    const conflicts = this.entries
      .map(({ holder }) => holder)
      .filter(
        (holder) =>
          holder.scope.kind !== "app" || COMPUTER_CHROME_APP_IDS.includes(holder.scope.appId),
      );
    return (
      conflicts.find((holder) => holder.profileId === profileId) ??
      conflicts[0] ??
      this.pending?.holder ??
      null
    );
  }
  touch(holder: ComputerLeaseHolder): void {
    const entry = this.entries.find((candidate) => sameComputerHolder(candidate.holder, holder));
    if (entry) entry.lastMutationAt = this.now();
  }
  /** Retire a yielded native generation without releasing its exclusive foreground scope. */
  rotate(
    holder: ComputerLeaseHolder,
    beforePublish: (next: ComputerLeaseHolder) => void,
    authorization: ComputerLeaseHolder = holder,
  ): ComputerLeaseHolder {
    const entry = this.entries.find((candidate) => sameComputerHolder(candidate.holder, holder));
    if (!entry) throw new ComputerControlError({ _tag: "Interrupted", cause: "turn-ended" });
    if (
      !sameThread(entry.holder, authorization) ||
      entry.holder.sessionGeneration !== authorization.sessionGeneration ||
      entry.holder.turnId !== authorization.turnId ||
      entry.holder.policyRevision !== authorization.policyRevision ||
      !sameComputerScope(entry.holder.scope, authorization.scope)
    )
      throw new ComputerControlError({ _tag: "ReplayRejected" });
    const next = { ...authorization, executionGeneration: ++this.generation };
    beforePublish(next);
    entry.holder = next;
    entry.lastMutationAt = this.now();
    this.notify();
    return next;
  }
  release(holder: ComputerLeaseHolder): void {
    const before = this.entries.length;
    this.entries = this.entries.filter((entry) => !sameComputerHolder(entry.holder, holder));
    if (this.entries.length !== before) this.notify();
  }
  releaseProfile(profileId: string): void {
    this.invalidate((holder) => holder.profileId === profileId);
    if (this.pending?.holder.profileId === profileId) this.cancelTakeover();
  }
  invalidate(predicate: (holder: ComputerLeaseHolder) => boolean = () => true): void {
    ++this.generation;
    const before = this.entries.length;
    this.entries = this.entries.filter((entry) => !predicate(entry.holder));
    if (this.entries.length !== before) this.notify();
  }
  sweep(): void {
    const now = this.now();
    const before = this.entries.length;
    this.entries = this.entries.filter((entry) => now - entry.lastMutationAt < 60_000);
    if (this.entries.length !== before) this.notify();
  }
  subscribe(listener: (holders: ReadonlyArray<ComputerLeaseHolder>) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  private busy(
    holder: Pick<ComputerLeaseHolder, "profileId" | "threadTitle">,
    profileId: string,
  ): ComputerControlError {
    return new ComputerControlError({
      _tag: "Busy",
      holder: holder.profileId === profileId ? "same-profile" : "other-profile",
      ...(holder.profileId === profileId ? { threadTitle: holder.threadTitle } : {}),
    });
  }
  private notify(): void {
    const holders = this.holders();
    for (const listener of this.listeners) {
      try {
        listener(holders);
      } catch {
        /* Authority must survive a failing observer. */
      }
    }
  }
}
