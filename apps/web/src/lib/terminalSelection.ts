import type { Terminal } from "@xterm/xterm";

// Bound formatting work even for selections spanning the entire scrollback.
const MAX_COMPARED_SELECTION_CELLS = 3_000;

export function createTerminalOutputWriter(
  terminal: Pick<
    Terminal,
    | "cols"
    | "element"
    | "write"
    | "getSelectionPosition"
    | "getSelection"
    | "clearSelection"
    | "onSelectionChange"
  >,
) {
  let revision = 0;
  let disposed = false;
  let dragging = false;
  const subscription = terminal.onSelectionChange(() => revision++);
  const element = terminal.element;
  const document = element?.ownerDocument;
  const startDrag = (event: MouseEvent) => {
    if (event.button !== 0) return;
    dragging = true;
    revision++;
  };
  const endDrag = (event: MouseEvent) => {
    if (event.button !== 0 || !dragging) return;
    dragging = false;
    revision++;
  };
  // xterm only announces mouse selection changes on release. Protect the
  // entire gesture, including writes queued before the user starts dragging.
  element?.addEventListener("mousedown", startDrag, true);
  document?.addEventListener("mouseup", endDrag, true);

  return {
    write(data: string, reset = false) {
      if (disposed || (!data && !reset)) return;
      const position = terminal.getSelectionPosition();
      const cells = position ? (position.end.y - position.start.y + 1) * terminal.cols : 0;
      const compared = !reset && !dragging && cells > 0 && cells <= MAX_COMPARED_SELECTION_CELLS;
      const selection = compared ? terminal.getSelection() : "";
      const before = revision;
      // Submit directly so xterm retains ownership of buffering and its discard
      // watermark. Only clear when output demonstrably changed a small selection.
      terminal.write(reset ? "\u001bc" + data : data, () => {
        if (
          !disposed &&
          compared &&
          !dragging &&
          revision === before &&
          terminal.getSelection() !== selection
        ) {
          terminal.clearSelection();
        }
      });
    },
    dispose() {
      disposed = true;
      subscription.dispose();
      element?.removeEventListener("mousedown", startDrag, true);
      document?.removeEventListener("mouseup", endDrag, true);
    },
  };
}

export function currentTerminalContextSelection<T extends { text: string }>(
  original: T,
  current: T | null,
): T | null {
  return current?.text === original.text ? current : null;
}
