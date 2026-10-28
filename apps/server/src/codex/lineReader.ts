import { EventEmitter } from "node:events";
import type { Readable } from "node:stream";
import { Utf8Lines } from "@t3tools/shared/utf8Lines";

/** Node source wiring stays server-side; the decoder/framer is shared with ACP. */
export class ProviderLineReader extends EventEmitter<{
  line: [string];
  overflow: [Error];
  close: [];
}> {
  private readonly lines: Utf8Lines;
  private closed = false;
  /**
   * `maxLineBytes` bounds one line's UTF-8 bytes (the LF is excluded). A longer
   * line emits `overflow` and closes the reader instead of buffering it.
   */
  constructor(
    private readonly source: Readable,
    maxLineBytes = Infinity,
  ) {
    super();
    this.lines = new Utf8Lines(maxLineBytes);
    source.on("data", this.data);
    source.on("end", this.end);
    source.on("close", this.end);
  }
  private readonly data = (chunk: Buffer | string) => {
    let lines: string[];
    try {
      lines = this.lines.push(chunk);
    } catch (error) {
      this.overflow(error);
      return;
    }
    for (const line of lines) this.emit("line", line);
  };
  private readonly end = () => {
    if (this.closed) return;
    let lines: string[];
    try {
      lines = this.lines.finish();
    } catch (error) {
      this.overflow(error);
      return;
    }
    for (const line of lines) this.emit("line", line);
    this.close();
  };
  private overflow(error: unknown): void {
    if (this.closed) return;
    this.emit("overflow", error instanceof Error ? error : new Error(String(error)));
    this.close();
  }
  /** Flush an already received final fragment before releasing a draining source. */
  finish(): void {
    this.end();
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.source.off("data", this.data);
    this.source.off("end", this.end);
    this.source.off("close", this.end);
    this.emit("close");
  }
}
