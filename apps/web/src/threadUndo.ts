import { toastManager } from "./components/ui/toast";

interface UndoEntry {
  id: string;
  expiresAt: number;
  undo: () => Promise<void>;
}
const entries: UndoEntry[] = [];
let running = false;
// A new undo notice owns mod+z even inside a text field, until the user presses
// another key or edits text. After that, mod+z is the field's own undo again.
let shortcutClaimed = false;

export function canUndoThreadAction(now = Date.now()): boolean {
  return !running && entries.some((entry) => entry.expiresAt > now);
}

/** Whether mod+z should undo thread actions even while a text field is focused. */
export function threadUndoClaimsShortcut(now = Date.now()): boolean {
  return shortcutClaimed && canUndoThreadAction(now);
}

/** Called on any other keypress or text edit; hands mod+z back to text fields. */
export function releaseThreadUndoShortcut(): void {
  shortcutClaimed = false;
}

export function recordThreadUndo(title: string, undo: () => Promise<void>): void {
  const id = crypto.randomUUID();
  const entry: UndoEntry = { id, expiresAt: Date.now() + 8000, undo };
  entries.push(entry);
  shortcutClaimed = true;
  while (entries.length > 10) {
    const removed = entries.shift()!;
    toastManager.close(removed.id);
  }
  toastManager.add({
    id,
    title,
    timeout: 8000,
    onClose: () => {
      const index = entries.indexOf(entry);
      if (index >= 0) entries.splice(index, 1);
    },
    actionProps: {
      children: "Undo",
      onClick: (event) => {
        event.preventDefault();
        void undoThreadAction(id);
      },
    },
  });
}

export async function undoThreadAction(id?: string): Promise<boolean> {
  if (running) return false;
  const entry = entries.findLast(
    (candidate) => candidate.expiresAt > Date.now() && (id === undefined || candidate.id === id),
  );
  if (!entry) return false;
  running = true;
  try {
    await entry.undo();
    const index = entries.indexOf(entry);
    if (index >= 0) entries.splice(index, 1);
    toastManager.close(entry.id);
    return true;
  } catch (error) {
    toastManager.add({
      type: "error",
      title: "Could not undo thread action",
      description: error instanceof Error ? error.message : String(error),
    });
    return false;
  } finally {
    running = false;
  }
}
