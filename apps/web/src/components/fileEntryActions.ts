import type { ContextMenuItem, NativeApi, ProjectEntry } from "@t3tools/contracts";

import { openInPreferredEditor } from "../editorPreferences";
import { writeTextToClipboard } from "../hooks/useCopyToClipboard";
import { resolvePathLinkTarget } from "../terminal-links";
import { toastManager } from "./ui/toast";

type FileEntryAction =
  | "add-to-chat"
  | "copy-path"
  | "copy-relative-path"
  | "open-in-editor"
  | "reveal-in-file-manager";

export const FILE_ENTRY_CONTEXT_MENU_ITEMS: readonly ContextMenuItem<FileEntryAction>[] = [
  { id: "add-to-chat", label: "Add to chat" },
  { id: "copy-path", label: "Copy path" },
  { id: "copy-relative-path", label: "Copy relative path" },
  { id: "open-in-editor", label: "Open in editor" },
  { id: "reveal-in-file-manager", label: "Reveal in file manager" },
];

function itemsForEntry(kind: ProjectEntry["kind"]): readonly ContextMenuItem<FileEntryAction>[] {
  return kind === "file"
    ? FILE_ENTRY_CONTEXT_MENU_ITEMS
    : FILE_ENTRY_CONTEXT_MENU_ITEMS.filter((item) => item.id !== "add-to-chat");
}

export async function showFileEntryContextMenu(input: {
  api: NativeApi;
  cwd: string;
  entry: Pick<ProjectEntry, "kind" | "path">;
  position: { x: number; y: number };
  onAddToChat: (relativePath: string) => boolean;
}): Promise<void> {
  const action = await input.api.contextMenu.show(itemsForEntry(input.entry.kind), input.position);
  if (action === null) return;

  const absolutePath = resolvePathLinkTarget(input.entry.path, input.cwd);
  try {
    switch (action) {
      case "add-to-chat":
        if (input.entry.kind !== "file" || !input.onAddToChat(input.entry.path)) {
          throw new Error("The chat composer is not ready to accept input.");
        }
        return;
      case "copy-path":
        await writeTextToClipboard(absolutePath);
        toastManager.add({ type: "success", title: "Path copied" });
        return;
      case "copy-relative-path":
        await writeTextToClipboard(input.entry.path);
        toastManager.add({ type: "success", title: "Relative path copied" });
        return;
      case "open-in-editor":
        await openInPreferredEditor(input.api, absolutePath);
        return;
      case "reveal-in-file-manager":
        await input.api.shell.revealInFileManager(absolutePath);
        return;
    }
  } catch (error) {
    toastManager.add({
      type: "error",
      title: action === "add-to-chat" ? "Unable to add to chat" : "File action failed",
      description: error instanceof Error ? error.message : "Unknown file action error.",
    });
  }
}
