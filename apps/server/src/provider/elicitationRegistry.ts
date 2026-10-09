import type {
  ApprovalRequestId,
  ElicitationAction,
  ElicitationDescriptor,
  ElicitationValue,
  TurnId,
} from "@t3tools/contracts";
import { validateElicitationContent } from "@t3tools/shared/elicitationForm";

/** What the adapter hands to the native transport; never logged or persisted. */
export interface ElicitationResponse {
  readonly action: ElicitationAction;
  readonly content?: Readonly<Record<string, ElicitationValue>>;
}

export type ElicitationTerminalReceipt = "resolved" | "cancelled" | "indeterminate";

/** Raised when the native transport failed after the answer may have left F5. */
export class ElicitationDeliveryUncertainError extends Error {
  constructor(message = "The provider connection failed while the answer was being sent.") {
    super(message);
    this.name = "ElicitationDeliveryUncertainError";
  }
}

interface Entry {
  readonly descriptor: ElicitationDescriptor;
  readonly turnId: TurnId | undefined;
  readonly deliver: (response: ElicitationResponse) => Promise<void>;
  /** Releases a provider callback still waiting on an unanswered request. */
  readonly abort: (() => void) | undefined;
  state: "pending" | "submitting" | "submitted";
}

/**
 * Per-session registry of open provider elicitations. Answer values exist only
 * in the argument of `submit` and in the native `deliver` call: nothing here
 * stores, logs or emits them. Each request accepts exactly one submission;
 * a second or concurrent submission is refused, and a transport failure after
 * delivery started is reported as indeterminate and never retried.
 */
export class ElicitationRegistry {
  private readonly entries = new Map<ApprovalRequestId, Entry>();

  open(input: {
    readonly requestId: ApprovalRequestId;
    readonly descriptor: ElicitationDescriptor;
    readonly turnId?: TurnId | undefined;
    readonly deliver: (response: ElicitationResponse) => Promise<void>;
    readonly abort?: () => void;
  }): void {
    this.entries.set(input.requestId, {
      descriptor: input.descriptor,
      turnId: input.turnId,
      deliver: input.deliver,
      abort: input.abort,
      state: "pending",
    });
  }

  has(requestId: ApprovalRequestId): boolean {
    return this.entries.has(requestId);
  }

  /** Request whose URL elicitation id matches a native completion notification. */
  findByNativeId(nativeId: string): ApprovalRequestId | undefined {
    for (const [requestId, entry] of this.entries)
      if (entry.descriptor.nativeId === nativeId) return requestId;
    return undefined;
  }

  /**
   * Validates and delivers one answer. Resolves once the native transport
   * accepted it ("submitted"); the caller settles it on native completion.
   */
  async submit(
    requestId: ApprovalRequestId,
    response: { readonly action: ElicitationAction; readonly content?: unknown },
  ): Promise<"submitted"> {
    const entry = this.entries.get(requestId);
    if (!entry) throw new Error(`Unknown pending elicitation request: ${requestId}`);
    if (entry.state !== "pending")
      throw new Error("This request was already submitted; F5 never sends an answer twice.");
    let native: ElicitationResponse;
    if (response.action === "accept") {
      if (entry.descriptor.mode === "url") {
        if (response.content !== undefined && Object.keys(response.content ?? {}).length > 0)
          throw new Error("A link request does not take form values.");
        native = { action: "accept" };
      } else {
        const validated = validateElicitationContent(
          entry.descriptor.fields ?? [],
          response.content,
        );
        if (!validated.ok) throw new Error(validated.reason);
        native = { action: "accept", content: validated.value };
      }
    } else {
      if (response.content !== undefined && Object.keys(response.content ?? {}).length > 0)
        throw new Error("Declining or cancelling does not send form values.");
      native = { action: response.action };
    }
    entry.state = "submitting";
    try {
      await entry.deliver(native);
    } catch (error) {
      if (error instanceof ElicitationDeliveryUncertainError) {
        entry.state = "submitted";
        throw error;
      }
      entry.state = "pending";
      throw error;
    }
    entry.state = "submitted";
    return "submitted";
  }

  /** Removes and returns the request's terminal receipt, if it is still open. */
  settle(
    requestId: ApprovalRequestId,
    outcome: "completed" | "aborted",
  ): ElicitationTerminalReceipt | undefined {
    const entry = this.entries.get(requestId);
    if (!entry) return undefined;
    this.entries.delete(requestId);
    if (entry.state === "pending") entry.abort?.();
    if (outcome === "completed") return entry.state === "pending" ? "cancelled" : "resolved";
    return entry.state === "pending" ? "cancelled" : "indeterminate";
  }

  /** Requests opened during a turn, for settlement when that turn ends. */
  forTurn(turnId: TurnId): ReadonlyArray<ApprovalRequestId> {
    return [...this.entries].flatMap(([requestId, entry]) =>
      entry.turnId === turnId ? [requestId] : [],
    );
  }

  /** Settles every open request when the session's transport goes away. */
  abortAll(): ReadonlyArray<{
    readonly requestId: ApprovalRequestId;
    readonly receipt: ElicitationTerminalReceipt;
  }> {
    return [...this.entries.keys()].flatMap((requestId) => {
      const receipt = this.settle(requestId, "aborted");
      return receipt ? [{ requestId, receipt }] : [];
    });
  }
}
