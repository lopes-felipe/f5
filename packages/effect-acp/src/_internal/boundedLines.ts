/** Bounded framing for providers which mix auth notices into JSONL stdout. */
export class BoundedLines {
  private parts: string[] = [];
  private tail = "";
  private bytes = 0;
  private readonly encoder = new TextEncoder();

  constructor(private readonly maxBytes = 16 * 1024 * 1024) {}

  push(chunk: string): string[] {
    const lines: string[] = [];
    let start = 0;
    while (start < chunk.length) {
      const end = chunk.indexOf("\n", start);
      const fragment = chunk.slice(start, end < 0 ? undefined : end);
      this.bytes += this.encoder.encode(fragment).byteLength;
      if (this.bytes > this.maxBytes) throw new Error("ACP stdout line exceeds the 16 MiB limit");
      this.tail += fragment;
      if (end >= 0) {
        this.parts.push(this.tail);
        lines.push(this.parts.join("").replace(/\r$/, ""));
        this.parts = [];
        this.tail = "";
        this.bytes = 0;
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
