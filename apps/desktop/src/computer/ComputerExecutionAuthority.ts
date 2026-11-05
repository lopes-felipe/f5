import { randomUUID } from "node:crypto";
import type { ComputerLeaseHolder } from "@t3tools/contracts";
import { ComputerControlError } from "@t3tools/shared/computerControl";

interface Receipt {
  kind: "session" | "takeover";
  profileId: string;
  backendIncarnation: string;
  threadId: string;
  sessionGeneration: string;
  policyRevision: number;
  turnId?: string;
  appId?: string;
  grantVersion?: number;
  executionGeneration?: number;
}
export interface ComputerTakeoverReceiptInput {
  profileId: string;
  backendIncarnation: string;
  threadId: string;
  sessionGeneration: string;
  policyRevision: number;
  turnId: string;
  appId: string;
  grantVersion: number;
}
/**
 * Electron-owned execution receipts. Only main's native consent dialogs mint them; renderer,
 * backend and model input can only name a receipt, never create one. Every receipt is bound to
 * the profile, backend incarnation, thread, session and policy revision it was approved for.
 */
export class ComputerExecutionAuthority {
  private readonly receipts = new Map<string, Receipt>();
  private readonly revisions = new Map<string, number>();
  private key(profileId: string, threadId: string): string {
    return `${profileId}\0${threadId}`;
  }
  /** Per-session approval to keep acting in granted apps while the user works elsewhere. */
  approveSession(input: Omit<Receipt, "kind">): string {
    this.revoke(
      (receipt) =>
        receipt.kind === "session" &&
        receipt.profileId === input.profileId &&
        receipt.threadId === input.threadId,
    );
    const id = randomUUID();
    this.receipts.set(id, { ...input, kind: "session" });
    return id;
  }
  hasSessionApproval(
    profileId: string,
    backendIncarnation: string,
    threadId: string,
    sessionGeneration: string,
  ): boolean {
    for (const receipt of this.receipts.values())
      if (
        receipt.kind === "session" &&
        receipt.profileId === profileId &&
        receipt.backendIncarnation === backendIncarnation &&
        receipt.threadId === threadId &&
        receipt.sessionGeneration === sessionGeneration &&
        receipt.policyRevision >= this.minimumRevision(profileId, threadId)
      )
        return true;
    return false;
  }
  issueTakeover(input: ComputerTakeoverReceiptInput): string {
    const id = randomUUID();
    this.receipts.set(id, { ...input, kind: "takeover" });
    return id;
  }
  bindTakeover(receiptId: string, executionGeneration: number): void {
    const receipt = this.receipts.get(receiptId);
    if (receipt?.kind === "takeover" && receipt.executionGeneration === undefined)
      receipt.executionGeneration = executionGeneration;
  }
  continueTakeover(
    previous: ComputerLeaseHolder,
    next: ComputerLeaseHolder,
    backendIncarnation: string | undefined,
  ): void {
    if (previous.scope.kind !== "takeover" || !this.validTakeover(previous, backendIncarnation))
      throw new ComputerControlError({ _tag: "ReplayRejected" });
    this.receipts.get(previous.scope.approvalReceipt)!.executionGeneration =
      next.executionGeneration;
  }
  /** A takeover holder is valid only with its exact, still-bound receipt. */
  validTakeover(holder: ComputerLeaseHolder, backendIncarnation: string | undefined): boolean {
    if (holder.scope.kind !== "takeover") return false;
    const receipt = this.receipts.get(holder.scope.approvalReceipt);
    return (
      receipt?.kind === "takeover" &&
      receipt.backendIncarnation === backendIncarnation &&
      receipt.profileId === holder.profileId &&
      receipt.threadId === holder.threadId &&
      receipt.sessionGeneration === holder.sessionGeneration &&
      receipt.turnId === holder.turnId &&
      receipt.appId === holder.scope.appId &&
      receipt.policyRevision === holder.policyRevision &&
      receipt.executionGeneration === holder.executionGeneration &&
      holder.policyRevision >= this.minimumRevision(holder.profileId, holder.threadId)
    );
  }
  /** Policy transitions: older revisions are rejected from now on. */
  advanceRevision(profileId: string, threadId: string, revision: number): void {
    const key = this.key(profileId, threadId);
    if (revision <= (this.revisions.get(key) ?? 0)) return;
    this.revisions.set(key, revision);
    this.revoke(
      (receipt) =>
        receipt.profileId === profileId &&
        receipt.threadId === threadId &&
        receipt.policyRevision < revision,
    );
  }
  minimumRevision(profileId: string, threadId: string): number {
    return this.revisions.get(this.key(profileId, threadId)) ?? 0;
  }
  revisionAccepted(profileId: string, threadId: string, revision: number): boolean {
    return revision >= this.minimumRevision(profileId, threadId);
  }
  /** Closing a provider session releases all of its execution receipts. */
  sessionClosed(profileId: string, threadId: string, sessionGeneration: string): void {
    this.revoke(
      (receipt) =>
        receipt.profileId === profileId &&
        receipt.threadId === threadId &&
        receipt.sessionGeneration === sessionGeneration,
    );
  }

  /** A replaced provider session can never reuse an earlier session's receipts. */
  sessionChanged(profileId: string, threadId: string, sessionGeneration: string): void {
    this.revoke(
      (receipt) =>
        receipt.profileId === profileId &&
        receipt.threadId === threadId &&
        receipt.sessionGeneration !== sessionGeneration,
    );
  }
  /** Takeover receipts end with pause, stop, turn end and grant revocation. */
  revokeTakeovers(
    predicate: (receipt: { profileId: string; threadId: string; appId?: string }) => boolean,
  ): void {
    this.revoke((receipt) => receipt.kind === "takeover" && predicate(receipt));
  }
  disconnect(profileId: string): void {
    this.revoke((receipt) => receipt.profileId === profileId);
    for (const key of this.revisions.keys())
      if (key.startsWith(`${profileId}\0`)) this.revisions.delete(key);
  }
  private revoke(predicate: (receipt: Receipt) => boolean): void {
    for (const [id, receipt] of this.receipts) if (predicate(receipt)) this.receipts.delete(id);
  }
}
