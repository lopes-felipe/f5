/** A line exceeded the limit. `lines` holds the complete lines framed before it in the same chunk. */
export class Utf8LineOverflowError extends Error {
  constructor(
    readonly maxBytes: number,
    readonly lines: ReadonlyArray<string>,
  ) {
    super(`Provider stdout line exceeds the ${maxBytes} byte limit`);
    this.name = "Utf8LineOverflowError";
  }
}

/** UTF-8 length without allocating an encoded copy; lone surrogates count as U+FFFD (3 bytes). */
function utf8ByteLength(text: string): number {
  let bytes = 0;
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (
      code >= 0xd800 &&
      code <= 0xdbff &&
      index + 1 < text.length &&
      (text.charCodeAt(index + 1) & 0xfc00) === 0xdc00
    ) {
      bytes += 4;
      index++;
    } else bytes += 3;
  }
  return bytes;
}

/** Incremental UTF-8/CRLF framing. Unbounded unless the transport specifies a limit. */
export class Utf8Lines {
  private readonly decoder = new TextDecoder();
  private readonly encoder = new TextEncoder();
  private parts: string[] = [];
  private tail = "";
  private bytes = 0;
  private truncated = false;
  private ended = false;

  constructor(
    private readonly maxBytes = Infinity,
    private readonly overflow: "error" | "truncate" = "error",
  ) {}

  push(chunk: Uint8Array | string): string[] {
    if (this.ended) return [];
    return this.frame(
      typeof chunk === "string" ? chunk : this.decoder.decode(chunk, { stream: true }),
    );
  }

  finish(): string[] {
    if (this.ended) return [];
    const lines = this.frame(this.decoder.decode());
    if (this.bytes > 0 || this.truncated) lines.push(this.take());
    this.ended = true;
    return lines;
  }

  private take(): string {
    const line =
      (this.parts.join("") + this.tail).replace(/\r$/, "") + (this.truncated ? " [truncated]" : "");
    this.parts = [];
    this.tail = "";
    this.bytes = 0;
    this.truncated = false;
    return line;
  }

  private frame(chunk: string): string[] {
    const lines: string[] = [];
    let start = 0;
    while (start < chunk.length) {
      const end = chunk.indexOf("\n", start);
      let fragment = chunk.slice(start, end < 0 ? undefined : end);
      const size = Number.isFinite(this.maxBytes) ? utf8ByteLength(fragment) : fragment.length;
      if (this.bytes + size > this.maxBytes) {
        if (this.overflow === "error") throw new Utf8LineOverflowError(this.maxBytes, lines);
        let remaining = Math.max(0, this.maxBytes - this.bytes);
        let prefix = "";
        for (const character of fragment) {
          const bytes = this.encoder.encode(character).byteLength;
          if (bytes > remaining) break;
          prefix += character;
          remaining -= bytes;
        }
        fragment = prefix;
        this.truncated = true;
      }
      if (!this.truncated || this.bytes < this.maxBytes) this.tail += fragment;
      this.bytes = Math.min(this.maxBytes, this.bytes + size);
      if (end >= 0) {
        lines.push(this.take());
        start = end + 1;
      } else {
        if (this.tail.length >= 64 * 1024) {
          this.parts.push(this.tail);
          this.tail = "";
        }
        break;
      }
    }
    return lines;
  }
}
