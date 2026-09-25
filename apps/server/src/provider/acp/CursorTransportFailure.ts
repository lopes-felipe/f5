const diagnostic =
  /^Error: (?:RetriableError: (?!\[internal\]).+|ConnectError: \[(?:unavailable|aborted|deadline_exceeded)\].*)$/;
const serverError = "Something went wrong communicating with the server. Please try again.";

/** Recognize a standalone diagnostic, never prose/code that merely quotes one. */
export class CursorTransportFailure {
  private line = "";
  private rejected = false;
  private message: string | undefined;

  private consume(line: string) {
    const text = line.trimEnd();
    if (diagnostic.test(text) || text === serverError) this.message = text;
    else if (text.trim() && !(this.message && /^\s+at\s/.test(text))) {
      this.rejected = true;
      this.message = undefined;
    }
  }

  push(text: string) {
    if (this.rejected) return;
    for (const character of text) {
      if (character === "\n") {
        this.consume(this.line);
        this.line = "";
        if (this.rejected) return;
      } else {
        this.line += character;
        if (this.line.length > 4096) {
          this.rejected = true;
          this.message = undefined;
          this.line = "";
          return;
        }
      }
    }
  }

  get failure(): string | undefined {
    if (this.rejected) return undefined;
    const previous = this.message;
    const rejected = this.rejected;
    this.consume(this.line);
    const result = this.rejected ? undefined : this.message;
    this.message = previous;
    this.rejected = rejected;
    return result;
  }
}
