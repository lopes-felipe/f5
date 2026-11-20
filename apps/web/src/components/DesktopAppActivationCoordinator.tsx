import { useEffect, useRef } from "react";
import { useOpenLocalWorkspace } from "../hooks/useOpenLocalWorkspace";
import { toastManager } from "./ui/toast";

export function DesktopAppActivationCoordinator() {
  const { ready, open } = useOpenLocalWorkspace();
  const running = useRef(false);
  const wake = useRef<(() => void) | null>(null);
  useEffect(() => {
    const bridge = window.desktopBridge;
    if (!ready || !bridge?.takeAppActivations) return;
    let disposed = false;
    const take = async () => {
      if (running.current || disposed) return;
      running.current = true;
      try {
        for (;;) {
          const requests = await bridge.takeAppActivations!();
          if (!requests.length || disposed) break;
          for (const request of requests) {
            let error: string | undefined;
            try {
              await open(request.path, async () => {
                if (disposed)
                  throw new Error(
                    "Desktop activation was interrupted. Retry to reuse the project.",
                  );
                if ((await bridge.isAppActivationPending?.(request.id)) === false)
                  throw new Error("Desktop activation expired. Retry to reuse the project.");
              });
            } catch (cause) {
              error = cause instanceof Error ? cause.message : "Could not open project.";
              toastManager.add({ type: "error", title: error });
            }
            await bridge.completeAppActivation?.(request.id, error);
          }
        }
      } finally {
        running.current = false;
        if (disposed) wake.current?.();
      }
    };
    const run = () => {
      void take().catch(() => {});
    };
    wake.current = run;
    run();
    const unsubscribe = bridge.onAppActivationsAvailable?.(run);
    window.addEventListener("focus", run);
    return () => {
      disposed = true;
      if (wake.current === run) wake.current = null;
      unsubscribe?.();
      window.removeEventListener("focus", run);
    };
  }, [ready, open]);
  return null;
}
