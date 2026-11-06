import type { Terminal } from "@xterm/xterm";

// Bound formatting work even for selections spanning the entire scrollback.
const MAX_COMPARED_SELECTION_CELLS = 3_000;

export function createTerminalOutputWriter(
  terminal: Pick<
    Terminal,
    | "cols"
    | "write"
    | "getSelectionPosition"
    | "getSelection"
    | "clearSelection"
    | "onSelectionChange"
  >,
) {
  let revision = 0;
  let disposed = false;
  let writing = false;
  const pending: Array<{ data: string; reset: boolean }> = [];
  const subscription = terminal.onSelectionChange(() => revision++);

  const drain = () => {
    if (disposed || writing) return;
    const next = pending.shift();
    if (!next) return;
    writing = true;
    const position = terminal.getSelectionPosition();
    const cells = position ? (position.end.y - position.start.y + 1) * terminal.cols : 0;
    const compared = cells <= MAX_COMPARED_SELECTION_CELLS;
    const selection = cells > 0 && compared ? terminal.getSelection() : "";
    const before = revision;
    // xterm parses writes asynchronously. Serialize comparisons with parsing,
    // and never clear a new selection made while a write was pending.
    terminal.write(next.reset ? "\u001bc" + next.data : next.data, () => {
      if (disposed) return;
      if (
        revision === before &&
        (next.reset || !compared || (cells > 0 && terminal.getSelection() !== selection))
      ) {
        terminal.clearSelection();
      }
      writing = false;
      drain();
    });
  };

  return {
    write(data: string, reset = false) {
      if (disposed || (!data && !reset)) return;
      pending.push({ data, reset });
      drain();
    },
    dispose() {
      disposed = true;
      pending.length = 0;
      subscription.dispose();
    },
  };
}

export function currentTerminalContextSelection<T extends { text: string }>(
  original: T,
  current: T | null,
): T | null {
  return current?.text === original.text ? current : null;
}
