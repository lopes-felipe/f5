import { toUSVString } from "node:util";

/** Retained terminal output only; live PTY output is never truncated. */
export const TERMINAL_HISTORY_MAX_BYTES = 4 * 1024 * 1024;
const FRAGMENT_SIZE = 4096;

interface Fragment {
  text: string;
  offset: number;
  bytes: number;
  newlines: number;
}

/** A fragment deque. Append and eviction scan new/discarded text, not all history. */
export class BoundedTerminalHistory {
  private fragments: Array<Fragment | undefined> = [];
  private head = 0;
  private bytes = 0;
  private newlines = 0;
  private trailingNewline = false;
  private pendingSurrogate = "";
  private cached: string | null = "";

  constructor(
    private readonly maxLines = 5000,
    private readonly maxBytes = TERMINAL_HISTORY_MAX_BYTES,
  ) {
    if (
      !Number.isSafeInteger(maxLines) ||
      maxLines < 0 ||
      !Number.isSafeInteger(maxBytes) ||
      maxBytes < 0
    )
      throw new RangeError("Terminal history limits must be nonnegative integers");
  }

  get byteLength(): number {
    return this.bytes;
  }

  append(input: string): void {
    if (!input) return;
    let text = this.pendingSurrogate + input;
    this.pendingSurrogate = "";
    const last = text.charCodeAt(text.length - 1);
    if (last >= 0xd800 && last <= 0xdbff) {
      // PTY adapters decode UTF-8 as a stream. Also join JS surrogate pairs when
      // a string producer splits a pair between callbacks, before counting bytes.
      this.pendingSurrogate = text.slice(-1);
      text = text.slice(0, -1);
    }
    text = toUSVString(text);
    if (!this.maxLines || !this.maxBytes) return;
    for (let start = 0; start < text.length; ) {
      let end = Math.min(start + FRAGMENT_SIZE, text.length);
      const code = text.charCodeAt(end - 1);
      if (end < text.length && code >= 0xd800 && code <= 0xdbff) end--;
      // Copy bounded fragments so a retained suffix cannot pin a huge input.
      const part =
        text.length > FRAGMENT_SIZE
          ? Buffer.from(text.slice(start, end), "utf16le").toString("utf16le")
          : text.slice(start, end);
      const bytes = Buffer.byteLength(part);
      let newlines = 0;
      for (let i = part.indexOf("\n"); i !== -1; i = part.indexOf("\n", i + 1)) newlines++;
      const tail = this.fragments.at(-1);
      if (tail && tail.offset === 0 && tail.text.length + part.length <= FRAGMENT_SIZE) {
        tail.text += part;
        tail.bytes += bytes;
        tail.newlines += newlines;
      } else this.fragments.push({ text: part, offset: 0, bytes, newlines });
      this.bytes += bytes;
      this.newlines += newlines;
      this.trailingNewline = part.endsWith("\n");
      this.cached = null;
      this.trim();
      start = end;
    }
  }

  /** Finish a stopped stream without joining its pending half-pair to a new process. */
  finish(): boolean {
    if (!this.pendingSurrogate) return false;
    this.pendingSurrogate = "";
    this.append("\ufffd");
    return true;
  }

  private discardFragment(): void {
    const first = this.fragments[this.head]!;
    this.bytes -= first.bytes;
    this.newlines -= first.newlines;
    this.fragments[this.head++] = undefined;
  }

  private discardPrefix(end: number, bytes: number, newlines: number): void {
    const first = this.fragments[this.head]!;
    if (end === first.text.length) {
      this.discardFragment();
      return;
    }
    first.offset = end;
    first.bytes -= bytes;
    first.newlines -= newlines;
    this.bytes -= bytes;
    this.newlines -= newlines;
  }

  private discardLines(count: number): void {
    while (count > 0) {
      const first = this.fragments[this.head]!;
      if (first.newlines < count) {
        count -= first.newlines;
        this.discardFragment();
        continue;
      }
      let end = first.offset;
      for (let i = 0; i < count; i++) end = first.text.indexOf("\n", end) + 1;
      this.discardPrefix(end, Buffer.byteLength(first.text.slice(first.offset, end)), count);
      return;
    }
  }

  private trim(): void {
    const lines = this.newlines + (this.trailingNewline ? 0 : 1);
    this.discardLines(Math.max(0, lines - this.maxLines));
    while (this.bytes > this.maxBytes) {
      // Keep complete recent lines whenever possible. Only truncate within a
      // line when the last remaining line itself exceeds the byte ceiling.
      if (this.newlines > (this.trailingNewline ? 1 : 0)) {
        this.discardLines(1);
        continue;
      }
      const first = this.fragments[this.head]!;
      const excess = this.bytes - this.maxBytes;
      if (first.bytes <= excess) {
        this.discardFragment();
        continue;
      }
      let end = first.offset;
      let bytes = 0;
      let newlines = 0;
      while (bytes < excess) {
        const cp = first.text.codePointAt(end)!;
        bytes += cp <= 0x7f ? 1 : cp <= 0x7ff ? 2 : cp <= 0xffff ? 3 : 4;
        end += cp > 0xffff ? 2 : 1;
        if (cp === 10) newlines++;
      }
      this.discardPrefix(end, bytes, newlines);
    }
    if (
      this.head === this.fragments.length ||
      (this.head > 1024 && this.head * 2 > this.fragments.length)
    ) {
      this.fragments = this.fragments.slice(this.head);
      this.head = 0;
    }
  }

  clear(): void {
    this.fragments = [];
    this.head = this.bytes = this.newlines = 0;
    this.trailingNewline = false;
    this.pendingSurrogate = "";
    this.cached = "";
  }

  /** Materialize and cache the snapshot, compacting fragments to share its storage. */
  value(): string {
    if (this.cached !== null) return this.cached;
    this.cached = this.fragments
      .slice(this.head)
      .map((fragment) => fragment!.text.slice(fragment!.offset))
      .join("");
    // Share the materialized string instead of retaining a second full copy in
    // fragments. Future appends stay separate; eviction advances the head offset.
    this.fragments = this.cached
      ? [{ text: this.cached, offset: 0, bytes: this.bytes, newlines: this.newlines }]
      : [];
    this.head = 0;
    return this.cached;
  }
}
