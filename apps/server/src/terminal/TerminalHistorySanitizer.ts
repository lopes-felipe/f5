/** Filters request/reply traffic from retained output, never from the live PTY stream. */
export class TerminalHistorySanitizer {
  private mode: "text" | "escape" | "escapeIntermediate" | "csi" | "string" = "text";
  private pending = "";
  private stringKind = "";
  private stringEsc = false;
  private stripString: boolean | null = null;
  private oversizedCsi = false;

  clear(): void {
    this.mode = "text";
    this.pending = "";
    this.stringEsc = false;
    this.stripString = null;
    this.oversizedCsi = false;
  }

  append(input: string): string {
    const output: string[] = [];
    // eslint-disable-next-line no-control-regex -- Recognize 7-bit and C1 control introducers.
    const introducer = /[\x1b\x90\x9b\x9d\x9e\x9f]/g;
    // eslint-disable-next-line no-control-regex -- String terminators and cancellation controls.
    const stringControl = /[\x07\x18\x1a\x1b\x9c]/g;
    const flushString = () => {
      if (this.stripString === null) {
        const content = this.pending.slice(this.pending.startsWith("\x1b") ? 2 : 1);
        this.stripString =
          (this.stringKind === "P" && /^[01]?[$+][qr]/.test(content)) ||
          (this.stringKind === "]" && /^(10|11|12);(?:\?|rgb:)/.test(content));
      }
      if (!this.stripString) output.push(this.pending);
      this.pending = "";
    };
    const startString = (kind: string, introducer: string) => {
      this.mode = "string";
      this.stringKind = kind;
      this.pending = introducer;
      this.stripString = null;
      this.stringEsc = false;
    };
    for (let i = 0; i < input.length; i++) {
      const ch = input[i]!;
      const code = input.charCodeAt(i);
      if (
        code === 0x1b &&
        (this.mode === "escape" || this.mode === "escapeIntermediate" || this.mode === "csi")
      ) {
        output.push(this.pending);
        this.clear();
        this.mode = "escape";
        this.pending = ch;
        continue;
      }
      if (this.mode === "text") {
        // Copy ordinary text in runs rather than allocating one entry per character.
        introducer.lastIndex = i;
        const end = introducer.exec(input)?.index ?? input.length;
        if (end > i) output.push(input.slice(i, end));
        if (end === input.length) break;
        i = end;
        this.pending = input[i]!;
        const control = input.charCodeAt(i);
        if (control === 0x1b) this.mode = "escape";
        else if (control === 0x9b) this.mode = "csi";
        else startString(String.fromCharCode(control - 0x40), this.pending);
      } else if (this.mode === "escape") {
        if (ch === "[") {
          this.pending += ch;
          this.mode = "csi";
        } else if (["P", "]", "^", "_"].includes(ch)) {
          startString(ch, this.pending + ch);
        } else {
          this.pending += ch;
          if (code >= 0x20 && code <= 0x2f) this.mode = "escapeIntermediate";
          else {
            output.push(this.pending);
            this.clear();
          }
        }
      } else if (this.mode === "escapeIntermediate") {
        output.push(this.pending, ch);
        this.pending = "";
        if (code < 0x20 || code > 0x2f) this.clear();
      } else if (this.mode === "csi") {
        this.pending += ch;
        if (code >= 0x40 && code <= 0x7e) {
          const body = this.pending.slice(this.pending.startsWith("\x1b") ? 2 : 1, -1);
          const strip =
            ch === "n" ||
            (ch === "R" && /^[0-9;?]*$/.test(body)) ||
            (ch === "c" && /^[>0-9;?]*$/.test(body)) ||
            ((ch === "p" || ch === "y") && /^[0-9;?]*\$$/.test(body)) ||
            (ch === "q" && /^>[0-9;]*$/.test(body)) ||
            (ch === "u" && body.startsWith("?"));
          if (!strip && !this.oversizedCsi) output.push(this.pending);
          this.clear();
        } else if (this.pending.length > 4096) {
          // A malformed producer cannot grow retained parser state without bound.
          this.pending = "";
          this.oversizedCsi = true;
        }
      } else {
        if (this.stringEsc) {
          this.stringEsc = false;
          if (ch !== "\\") {
            // ESC aborts the string and introduces a new escape sequence.
            flushString();
            this.clear();
            this.mode = "escape";
            this.pending = "\x1b";
            i--;
            continue;
          }
          this.pending += "\x1b\\";
          flushString();
          this.clear();
          continue;
        }
        if (code === 0x1b) {
          // Defer ESC until the next chunk/byte distinguishes ST from a new sequence.
          this.stringEsc = true;
          continue;
        }
        if (this.stripString !== null) {
          stringControl.lastIndex = i;
          const end = stringControl.exec(input)?.index ?? input.length;
          if (end > i) {
            if (!this.stripString) output.push(input.slice(i, end));
            i = end - 1;
            continue;
          }
        }
        this.pending += ch;
        const ended = code === 7 || code === 0x9c || code === 0x18 || code === 0x1a;
        if (ended || this.pending.length >= 16 || this.stripString !== null) {
          flushString();
        }
        if (ended) this.clear();
      }
    }
    return output.join("");
  }
}
