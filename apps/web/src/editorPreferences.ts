import { EDITORS, EditorId, NativeApi } from "@t3tools/contracts";
import { getLocalStorageItem, setLocalStorageItem, useLocalStorage } from "./hooks/useLocalStorage";
import { useMemo } from "react";

const LAST_EDITOR_KEY = "t3code:last-editor";

export function usePreferredEditor(availableEditors: ReadonlyArray<EditorId>) {
  const [lastEditor, setLastEditor] = useLocalStorage(LAST_EDITOR_KEY, null, EditorId);

  const effectiveEditor = useMemo(() => {
    if (lastEditor && availableEditors.includes(lastEditor)) return lastEditor;
    return EDITORS.find((editor) => availableEditors.includes(editor.id))?.id ?? null;
  }, [lastEditor, availableEditors]);

  return [effectiveEditor, setLastEditor] as const;
}

export function resolveAndPersistPreferredEditor(
  availableEditors: readonly EditorId[],
): EditorId | null {
  const availableEditorIds = new Set(availableEditors);
  const stored = getLocalStorageItem(LAST_EDITOR_KEY, EditorId);
  if (stored && availableEditorIds.has(stored)) return stored;
  const editor = EDITORS.find((editor) => availableEditorIds.has(editor.id))?.id ?? null;
  if (editor) setLocalStorageItem(LAST_EDITOR_KEY, editor, EditorId);
  return editor ?? null;
}

export async function openInPreferredEditor(api: NativeApi, targetPath: string): Promise<EditorId> {
  return withEditorOpenAuthorization(targetPath, async (authorization) => {
    const { availableEditors } = await api.server.getConfig();
    const editor = resolveAndPersistPreferredEditor(availableEditors);
    if (!editor) throw new Error("No available editors found.");
    if (authorization) await api.shell.openInEditor(targetPath, editor, authorization);
    else await api.shell.openInEditor(targetPath, editor);
    return editor;
  });
}

/** Capture before async work; release unused grants for other editors and failed queries. */
export async function withEditorOpenAuthorization<T>(
  targetPath: string | undefined,
  open: (authorization: string | undefined) => Promise<T>,
): Promise<T> {
  const bridge = typeof window !== "undefined" ? window.desktopBridge : undefined;
  const authorization = await bridge?.prepareEditorOpen?.(targetPath);
  try {
    return await open(authorization);
  } finally {
    if (authorization && bridge?.releaseEditorOpen) {
      try {
        await bridge.releaseEditorOpen(authorization);
      } catch {
        // A closed renderer cannot release its grant; main still expires it.
      }
    }
  }
}
