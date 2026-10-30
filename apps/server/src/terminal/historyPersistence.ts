import fs from "node:fs";
import { BoundedTerminalHistory, TERMINAL_HISTORY_MAX_BYTES } from "./BoundedTerminalHistory";

// Turn off input modes a dead program left on: cursor/keypad application modes,
// mouse tracking and focus reports, bracketed paste and a hidden cursor. The
// Kitty keyboard pops run on both screens; a 1049 round trip keeps the main
// cursor, text and scrollback. xterm.js ignores the controls it does not support.
const INHERITED_INPUT_RESET =
  "\u001b[?1049h\u001b[<100u\u001b[=0;1u\u001b[?1049l" +
  "\u001b[?1;9;66;67;1000;1002;1003;1004;1005;1006;1015;2004l" +
  "\u001b[?25;1035;1036h\u001b[<100u\u001b[=0;1u\u001b[>4m";
const LONGEST_INHERITED_RESET_BYTES = Buffer.byteLength(
  INHERITED_INPUT_RESET + "\u001b7\u001b[?1049l",
);

/**
 * Bound history a previous shell left behind and append a reset for the modes it
 * left on, so a cold open starts the new shell on a clean main screen.
 */
export function neutralizeInheritedHistory(
  history: string,
  maxLines: number,
  maxBytes: number,
): string {
  if (!history.includes("\u001b")) return history;
  // Reserve room for the longest suffix so later trimming cannot drop the
  // alternate-screen entry after its exit is chosen from this exact window.
  const bounded = new BoundedTerminalHistory(
    // The suffix occupies the empty line after a trailing newline, too.
    Math.max(0, history.endsWith("\n") ? maxLines - 1 : maxLines),
    Math.max(0, maxBytes - LONGEST_INHERITED_RESET_BYTES),
  );
  bounded.append(history);
  history = bounded.value();
  if (!history.includes("\u001b")) return history;
  // An unconditional 1049 reset restores a stale saved cursor on the main
  // screen, so only leave an alternate screen the history actually entered.
  let alternateScreen: number | undefined;
  // eslint-disable-next-line no-control-regex -- Match replayed alternate-screen controls.
  for (const match of history.matchAll(/\u001b(?:\[\?([0-9;]+)([hl])|(c))/gu)) {
    if (match[3]) alternateScreen = undefined;
    for (const parameter of (match[1] ?? "").split(";")) {
      const mode = Number(parameter);
      if (mode === 47 || mode === 1047 || mode === 1049) {
        alternateScreen = match[2] === "h" ? (alternateScreen ?? mode) : undefined;
      }
    }
  }
  // Save the cursor first: if the entry was trimmed and the terminal is still on
  // the main screen, the 1049 exit restores this cursor instead of a stale one.
  const leaveAlternateScreen =
    alternateScreen === undefined ? "" : `\u001b7\u001b[?${alternateScreen}l`;
  return history + leaveAlternateScreen + INHERITED_INPUT_RESET;
}

/** Read only a bounded tail, with enough overlap to retain a complete UTF-8 suffix. */
export async function readTerminalHistory(file: string, maxLines: number) {
  const history = new BoundedTerminalHistory(maxLines);
  const handle = await fs.promises.open(file, "r");
  let size: number;
  let bytesRead = 0;
  let start: number;
  try {
    size = (await handle.stat()).size;
    start = Math.max(0, size - TERMINAL_HISTORY_MAX_BYTES - 4);
    const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, size - start));
    const decoder = new TextDecoder("utf-8", { ignoreBOM: true });
    let first = true;
    while (start + bytesRead < size) {
      const result = await handle.read(
        buffer,
        0,
        Math.min(buffer.length, size - start - bytesRead),
        start + bytesRead,
      );
      if (!result.bytesRead) break;
      bytesRead += result.bytesRead;
      let offset = 0;
      // Ignore continuation bytes only at a truncated file-tail boundary.
      if (first && start > 0) {
        while (offset < result.bytesRead && (buffer[offset]! & 0xc0) === 0x80) offset++;
        // A short read can consist entirely of continuation bytes.
        first = offset === result.bytesRead;
      } else first = false;
      history.append(decoder.decode(buffer.subarray(offset, result.bytesRead), { stream: true }));
    }
    history.append(decoder.decode());
    history.finish();
  } finally {
    await handle.close();
  }
  return { history, truncated: start > 0 || history.byteLength !== bytesRead };
}
