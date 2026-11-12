import type { ResolvedKeybindingsConfig } from "@t3tools/contracts";
import { useEffect } from "react";
import { isOpenFavoriteEditorShortcut } from "../../keybindings";

/** Capture before a focused terminal can swallow the shortcut. Only the visible target is enabled. */
export function useOpenFavoriteEditorShortcut({
  enabled,
  keybindings,
  onOpen,
}: {
  enabled: boolean;
  keybindings: ResolvedKeybindingsConfig;
  onOpen: () => void;
}) {
  useEffect(() => {
    if (!enabled) return;
    const handler = (event: KeyboardEvent) => {
      if (event.defaultPrevented || !isOpenFavoriteEditorShortcut(event, keybindings)) return;
      event.preventDefault();
      onOpen();
    };
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, [enabled, keybindings, onOpen]);
}
