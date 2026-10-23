import { piRecordField, piRecordNumber, type PiRpcRecord } from "./PiProtocol.ts";

export type PiTurnAction =
  | { readonly type: "send"; readonly record: PiRpcRecord; readonly timeoutMs: number }
  | {
      readonly type: "retry-probe";
      readonly turnId: string;
      readonly revision: number;
      readonly delayMs: number;
    }
  | {
      readonly type: "terminal";
      readonly turnId: string;
      readonly state: "completed" | "failed" | "interrupted";
    }
  | {
      readonly type: "stop-session";
      readonly reason:
        | "unowned-work"
        | "invalid-idle-state"
        | "idle-probe-timeout"
        | "native-protocol-error";
    };

interface ActiveTurn {
  readonly id: string;
  readonly requestId: string;
  readonly command: "prompt" | "compact";
  readonly commandOnly: boolean;
  revision: number;
  acknowledged: boolean;
  activity: boolean;
  settled: boolean;
  interrupted: boolean;
  failed: boolean;
  compacting: boolean;
  probe: { readonly id: string; readonly revision: number } | null;
}

/** Pure ownership/completion logic. Feed native responses in stdout order, including idle probes. */
export class PiTurnState {
  #active: ActiveTurn | null = null;
  #sequence = 0;
  #closed = false;
  get activeTurnId(): string | undefined {
    return this.#active?.id;
  }

  admit(input: {
    readonly turnId: string;
    readonly command: "prompt" | "compact";
    readonly commandOnly: boolean;
  }): string {
    if (this.#closed || this.#active)
      throw new Error("Pi cannot admit a turn while busy or closed.");
    const requestId = `f5-turn:${++this.#sequence}`;
    this.#active = {
      id: input.turnId,
      requestId,
      command: input.command,
      commandOnly: input.commandOnly,
      revision: 0,
      acknowledged: false,
      activity: false,
      settled: false,
      interrupted: false,
      failed: false,
      compacting: false,
      probe: null,
    };
    return requestId;
  }

  /** Called only after F5 admits an exact buffered continuation identity. No prompt is sent. */
  admitContinuation(turnId: string): void {
    this.admit({ turnId, command: "prompt", commandOnly: false });
    this.#active!.acknowledged = true;
  }

  /** A send failure is ambiguous: the caller must stop the owned process before reporting failure. */
  close(): void {
    this.#closed = true;
    this.#active = null;
  }
  interrupt(): PiRpcRecord | undefined {
    const turn = this.#active;
    if (!turn || this.#closed) return undefined;
    turn.interrupted = true;
    turn.revision++;
    turn.probe = null;
    return { type: "abort" };
  }

  #probe(turn: ActiveTurn): PiTurnAction[] {
    if (turn.probe || turn.compacting || !turn.acknowledged) return [];
    const id = `f5-idle:${++this.#sequence}`;
    turn.probe = { id, revision: turn.revision };
    // Do not use the transport's correlated request helper: the response must
    // remain behind all earlier native events in the same stdout stream.
    return [{ type: "send", record: { type: "get_state", id }, timeoutMs: 2000 }];
  }
  retryProbe(turnId: string, revision: number): PiTurnAction[] {
    const turn = this.#active;
    return !this.#closed &&
      turn?.id === turnId &&
      turn.revision === revision &&
      (turn.settled || (turn.commandOnly && !turn.activity))
      ? this.#probe(turn)
      : [];
  }
  expireProbe(requestId: string): PiTurnAction[] {
    if (this.#closed || this.#active?.probe?.id !== requestId) return [];
    this.#closed = true;
    return [{ type: "stop-session", reason: "idle-probe-timeout" }];
  }

  observe(event: PiRpcRecord): PiTurnAction[] {
    if (this.#closed) return [];
    if (event.type === "response" && event.command === "parse" && event.success === false) {
      this.#closed = true;
      return [{ type: "stop-session", reason: "native-protocol-error" }];
    }
    const turn = this.#active;
    if (!turn) {
      if (event.type === "agent_start" || event.type === "tool_execution_start") {
        this.#closed = true;
        return [{ type: "stop-session", reason: "unowned-work" }];
      }
      return [];
    }
    if (event.type === "response" && turn.probe !== null && event.id === turn.probe.id) {
      const probe = turn.probe;
      turn.probe = null;
      if (probe.revision !== turn.revision) return [];
      const data = event.data;
      const streaming = piRecordField(data, "isStreaming");
      const pending = piRecordNumber(data, "pendingMessageCount");
      if (
        event.success !== true ||
        typeof streaming !== "boolean" ||
        pending === undefined ||
        pending < 0 ||
        !Number.isSafeInteger(pending)
      ) {
        this.#closed = true;
        return [{ type: "stop-session", reason: "invalid-idle-state" }];
      }
      if (streaming || piRecordField(data, "isCompacting") === true || pending !== 0)
        return [{ type: "retry-probe", turnId: turn.id, revision: turn.revision, delayMs: 50 }];
      this.#active = null;
      return [
        {
          type: "terminal",
          turnId: turn.id,
          state: turn.interrupted ? "interrupted" : turn.failed ? "failed" : "completed",
        },
      ];
    }
    if (
      event.type === "response" &&
      event.id === turn.requestId &&
      event.command === turn.command
    ) {
      if (turn.acknowledged) return [];
      if (event.success !== true && event.success !== false) return [];
      turn.acknowledged = true;
      if (event.success === false) {
        turn.failed = true;
        turn.settled = true;
      }
      return turn.settled || (turn.commandOnly && !turn.activity) ? this.#probe(turn) : [];
    }
    if (
      event.type === "agent_start" ||
      event.type === "message_start" ||
      event.type === "message_update" ||
      event.type === "tool_execution_start" ||
      event.type === "compaction_start"
    ) {
      turn.revision++;
      turn.probe = null;
      if (event.type === "compaction_start") turn.compacting = true;
      else {
        turn.activity = true;
        turn.settled = false;
      }
    }
    if (
      event.type === "message_end" &&
      piRecordField(event.message, "role") === "assistant" &&
      piRecordField(event.message, "stopReason") === "error"
    )
      turn.failed = true;
    if (event.type === "auto_retry_end") turn.failed = event.success !== true;
    if (event.type === "compaction_end") {
      turn.compacting = false;
      if (event.willRetry === true) turn.failed = false;
      else if (event.aborted === true && turn.command === "compact") turn.interrupted = true;
      else if ((event.result === null || event.result === undefined) && turn.command === "compact")
        turn.failed = true;
      if (turn.command === "compact") turn.settled = true;
      return turn.settled || (turn.commandOnly && !turn.activity) ? this.#probe(turn) : [];
    }
    if (event.type === "agent_settled") {
      turn.settled = true;
      turn.interrupted ||= event.aborted === true;
      return this.#probe(turn);
    }
    return [];
  }
}
