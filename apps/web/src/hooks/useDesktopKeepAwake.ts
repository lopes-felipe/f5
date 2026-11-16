import { useCallback, useEffect, useState } from "react";
import type { DesktopKeepAwakeState } from "@t3tools/contracts";

export function useDesktopKeepAwake() {
  const [state, setState] = useState<DesktopKeepAwakeState | null>(null);
  const accept = useCallback((next: DesktopKeepAwakeState) => {
    setState((current) => (!current || next.revision >= current.revision ? next : current));
  }, []);
  useEffect(() => {
    const bridge = window.desktopBridge?.keepAwake;
    if (!bridge) return;
    let mounted = true;
    const receive = (next: DesktopKeepAwakeState) => {
      if (mounted) accept(next);
    };
    const unsubscribe = bridge.onState(receive);
    const refresh = () => {
      void bridge
        .getState()
        .then(receive)
        .catch(() => {});
    };
    refresh();
    window.addEventListener("focus", refresh);
    return () => {
      mounted = false;
      unsubscribe();
      window.removeEventListener("focus", refresh);
    };
  }, [accept]);
  return {
    state,
    accept,
    bridge: typeof window === "undefined" ? undefined : window.desktopBridge?.keepAwake,
  };
}
