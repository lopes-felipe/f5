import { NATIVE_CONTINUATION_ADMISSION_MS } from "../continuationPolicy.ts";
import { stringifyWithinBytes } from "@t3tools/shared/boundedJson";
import { piRecordNumber, type PiRpcRecord } from "./PiProtocol.ts";

const MAX_WAKE_BYTES = 2 * 1024 * 1024;
const MAX_WAKE_EVENTS = 256;
export const PI_NATIVE_WAKE_ADMISSION_MS = NATIVE_CONTINUATION_ADMISSION_MS;

interface BufferedEvent {
  readonly event: PiRpcRecord;
  readonly receivedAt: number;
}
/** A native wake waits for F5 queue admission. It cannot become a user prompt or survive replacement. */
export class PiNativeWake {
  readonly #events: BufferedEvent[] = [];
  #bytes = 0;
  #consumed = false;
  #adopted = false;
  get adopted() {
    return this.#adopted;
  }
  constructor(
    readonly requestId: string,
    readonly generation: string,
    readonly createdAt: number,
  ) {}
  get size() {
    return this.#events.length;
  }
  isCurrent(requestId: string, generation: string, now: number): boolean {
    return (
      !this.#consumed &&
      requestId === this.requestId &&
      generation === this.generation &&
      Number.isFinite(now) &&
      now >= this.createdAt &&
      now < this.createdAt + PI_NATIVE_WAKE_ADMISSION_MS
    );
  }
  push(event: PiRpcRecord, now: number): boolean {
    if (
      !this.isCurrent(this.requestId, this.generation, now) ||
      this.#events.length >= MAX_WAKE_EVENTS
    )
      return false;
    const json = stringifyWithinBytes(event, MAX_WAKE_BYTES - this.#bytes);
    if (json === undefined) return false;
    this.#bytes += Buffer.byteLength(json);
    this.#events.push({ event, receivedAt: now });
    return true;
  }
  /** Exact one-shot claim; failed/stale claims never release another generation's output. */
  take(requestId: string, generation: string, now: number): readonly PiRpcRecord[] | null {
    if (!this.isCurrent(requestId, generation, now)) return null;
    this.#consumed = true;
    this.#adopted = true;
    const events = this.#events.splice(0).map(({ event, receivedAt }) => {
      const timeout =
        event.type === "extension_ui_request" ? piRecordNumber(event, "timeout") : undefined;
      // Queue admission must not grant a native dialog a fresh timeout window.
      if (timeout === undefined || timeout <= 0) return event;
      const remaining = receivedAt + timeout - now;
      return { ...event, timeout: remaining <= 0 ? -1 : remaining };
    });
    this.#bytes = 0;
    return events;
  }
  cancel(): void {
    this.#consumed = true;
    this.#events.length = 0;
    this.#bytes = 0;
  }
}
