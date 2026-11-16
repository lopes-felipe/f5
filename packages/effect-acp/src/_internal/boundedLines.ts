import { Utf8Lines } from "@t3tools/shared/utf8Lines";

/** ACP preserves its existing 16 MiB frame ceiling. */
export class BoundedLines extends Utf8Lines {
  constructor(maxBytes = 16 * 1024 * 1024) {
    super(maxBytes);
  }
}
