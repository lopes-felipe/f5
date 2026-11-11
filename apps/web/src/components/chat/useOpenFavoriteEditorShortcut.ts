import type { ResolvedKeybindingsConfig } from "@t3tools/contracts";
import { useEffect } from "react";
import { isOpenFavoriteEditorShortcut } from "../../keybindings";

/** File previews capture the shortcut before the workspace's bubbling fallback. */
export function useOpenFavoriteEditorShortcut({
  enabled,
  keybindings,
  onOpen,
  capture = false,
}: {
  enabled: boolean;
  keybindings: ResolvedKeybindingsConfig;
  onOpen: () => void;
  capture?: boolean;
}) {
  useEffect(() => {
    if (!enabled) return;
    const handler = (event: KeyboardEvent) => {
      if (event.defaultPrevented || !isOpenFavoriteEditorShortcut(event, keybindings)) return;
      event.preventDefault();
      onOpen();
    };
    window.addEventListener("keydown", handler, capture);
    return () => window.removeEventListener("keydown", handler, capture);
  }, [enabled, keybindings, onOpen, capture]);
}
