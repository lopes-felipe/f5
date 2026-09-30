import { useEffect, useState } from "react";
import type { QuitShortcutHintEvent } from "@t3tools/contracts";
import { useAppSettings } from "../appSettings";

export function QuitHoldOverlay() {
  const { settings } = useAppSettings();
  const [hint, setHint] = useState<QuitShortcutHintEvent>({ state: "up" });
  useEffect(() => {
    void window.desktopBridge?.setQuitShortcutMode?.(settings.quitShortcutMode);
  }, [settings.quitShortcutMode]);
  useEffect(() => window.desktopBridge?.onQuitShortcut?.(setHint), []);
  if (hint.state === "up") return null;
  const shortcut = /Mac/.test(navigator.platform) ? "⌘Q" : "Ctrl+Q";
  return (
    <div
      role="status"
      className="pointer-events-none fixed inset-x-0 top-[22%] z-[100] flex justify-center"
    >
      <div className="rounded-full bg-card px-8 py-4 text-xl font-semibold shadow-xl border">
        {hint.mode === "hold"
          ? `Hold ${shortcut} or press twice to quit`
          : `Press ${shortcut} again to quit`}
      </div>
    </div>
  );
}
