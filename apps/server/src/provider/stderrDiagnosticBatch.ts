import type { ProviderEvent } from "@t3tools/contracts";

export const MAX_DIAGNOSTIC_TEXT_BYTES = 16 * 1024;

/**
 * A bounded, leading excerpt of consecutive stderr notifications. Reserve the
 * whole text allowance up front so merging cannot allocate promises or leases.
 */
export class StderrDiagnosticBatch {
  readonly first: ProviderEvent;
  private text = "";
  private textBytes = 0;
  private omitted = 0;
  private readonly earlierOmitted: number;
  private full = false;
  private truncated = false;

  constructor(event: ProviderEvent, omitted = 0) {
    this.first = { ...event, message: undefined };
    this.earlierOmitted = omitted;
    this.append(event.message ?? "Codex process stderr");
  }

  get reservationBytes(): number {
    // Include the event envelope and space for the omission summary/metadata.
    return Buffer.byteLength(JSON.stringify(this.first)) + MAX_DIAGNOSTIC_TEXT_BYTES + 256;
  }

  append(message: string): void {
    if (this.full) {
      this.omitted = Math.min(Number.MAX_SAFE_INTEGER, this.omitted + 1);
      return;
    }
    const separator = this.text ? "\n" : "";
    const available = MAX_DIAGNOSTIC_TEXT_BYTES - this.textBytes;
    if (Buffer.byteLength(separator) + Buffer.byteLength(message) > available) {
      if (available > separator.length) {
        // Streaming decode leaves an incomplete UTF-8 code point out of the excerpt.
        const prefix = new TextDecoder().decode(
          Buffer.from(message).subarray(0, available - separator.length),
          { stream: true },
        );
        if (prefix) {
          this.text += separator + prefix;
          this.textBytes = Buffer.byteLength(this.text);
          this.truncated = true;
        }
      }
      this.full = true;
      if (!this.truncated) this.omitted = Math.min(Number.MAX_SAFE_INTEGER, this.omitted + 1);
      return;
    }
    this.text += separator + message;
    this.textBytes += Buffer.byteLength(separator) + Buffer.byteLength(message);
  }

  toEvent(): ProviderEvent {
    const lines = (count: number) => count + " stderr " + (count === 1 ? "line" : "lines");
    const earlier = this.earlierOmitted
      ? "[" + lines(this.earlierOmitted) + " omitted earlier]\n"
      : "";
    const truncated = this.truncated ? "…[stderr line truncated]" : "";
    const omitted = this.omitted ? "\n[" + lines(this.omitted) + " omitted]" : "";
    return {
      ...this.first,
      message: earlier + this.text + truncated + omitted,
      ...(this.earlierOmitted || this.omitted || this.truncated
        ? {
            payload: {
              ...(this.first.payload !== undefined ? { originalPayload: this.first.payload } : {}),
              earlierOmittedLines: this.earlierOmitted,
              omittedLines: this.omitted,
              truncated: this.truncated,
            },
          }
        : {}),
    };
  }
}
