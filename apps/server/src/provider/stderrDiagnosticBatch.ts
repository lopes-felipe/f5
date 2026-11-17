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
  private omitted: number;
  private truncated = false;

  constructor(event: ProviderEvent, omitted = 0) {
    this.first = { ...event, message: undefined };
    this.omitted = omitted;
    this.append(event.message ?? "Codex process stderr");
  }

  get reservationBytes(): number {
    // Include the event envelope and space for the omission summary/metadata.
    return Buffer.byteLength(JSON.stringify(this.first)) + MAX_DIAGNOSTIC_TEXT_BYTES + 256;
  }

  append(message: string): void {
    const separator = this.text ? "\n" : "";
    const available = MAX_DIAGNOSTIC_TEXT_BYTES - this.textBytes;
    if (this.truncated || Buffer.byteLength(separator) + Buffer.byteLength(message) > available) {
      if (!this.truncated && available > separator.length) {
        // Streaming decode leaves an incomplete UTF-8 code point out of the excerpt.
        const prefix = new TextDecoder().decode(
          Buffer.from(message).subarray(0, available - separator.length),
          { stream: true },
        );
        this.text += separator + prefix;
        this.textBytes = Buffer.byteLength(this.text);
      }
      this.truncated = true;
      this.omitted = Math.min(Number.MAX_SAFE_INTEGER, this.omitted + 1);
      return;
    }
    this.text += separator + message;
    this.textBytes += Buffer.byteLength(separator) + Buffer.byteLength(message);
  }

  toEvent(): ProviderEvent {
    return {
      ...this.first,
      message: this.text + (this.omitted ? "\n[" + this.omitted + " stderr lines omitted]" : ""),
      ...(this.omitted
        ? { payload: { detail: this.first.payload, omittedLines: this.omitted } }
        : {}),
    };
  }
}
