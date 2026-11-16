/** Pi uses LF only. Unicode line/paragraph separators are ordinary JSON string data. */
export class PiLineFramer {
  #buffer = new Uint8Array(0);
  #length = 0;
  readonly #decoder = new TextDecoder("utf-8", { fatal: true });
  constructor(readonly maxBytes: number) {}
  #append(part: Uint8Array) {
    const needed = this.#length + part.length;
    if (needed > this.maxBytes) throw new Error("Pi frame exceeds the byte limit.");
    if (needed > this.#buffer.length) {
      const next = new Uint8Array(
        Math.min(this.maxBytes, Math.max(4096, needed, this.#buffer.length * 2)),
      );
      next.set(this.#buffer.subarray(0, this.#length));
      this.#buffer = next;
    }
    this.#buffer.set(part, this.#length);
    this.#length = needed;
  }
  #take() {
    const end =
      this.#length > 0 && this.#buffer[this.#length - 1] === 13 ? this.#length - 1 : this.#length;
    const line = this.#decoder.decode(this.#buffer.subarray(0, end));
    this.#length = 0;
    return line;
  }
  *push(chunk: Uint8Array): IterableIterator<string> {
    let start = 0;
    for (let offset = 0; offset < chunk.length; offset++) {
      if (chunk[offset] !== 10) continue;
      this.#append(chunk.subarray(start, offset));
      const line = this.#take();
      if (line) yield line;
      start = offset + 1;
    }
    this.#append(chunk.subarray(start));
  }
  finish(): string | undefined {
    return this.#length ? this.#take() : undefined;
  }
}
