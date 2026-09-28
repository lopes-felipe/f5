import { toastManager } from "./components/ui/toast";

interface UndoEntry {
  id: string;
  expiresAt: number;
  undo: () => Promise<void>;
}
const entries: UndoEntry[] = [];
let running = false;

export function canUndoThreadAction(now = Date.now()): boolean {
  return !running && entries.some((entry) => entry.expiresAt > now);
}

export function recordThreadUndo(title: string, undo: () => Promise<void>): void {
  const id = crypto.randomUUID();
  const entry: UndoEntry = { id, expiresAt: Date.now() + 8000, undo };
  entries.push(entry);
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
