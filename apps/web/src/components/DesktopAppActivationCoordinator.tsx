import { useEffect, useRef } from "react";
import { useStartupReady } from "../lib/startupReady";
import { useCreateProjectBackedDraftThread } from "../hooks/useCreateProjectBackedDraftThread";
import { ensureNativeApi } from "../nativeApi";
import { useStore } from "../store";
import { newCommandId, newProjectId } from "../lib/utils";
import { toastManager } from "./ui/toast";
import { useStableCallback } from "../hooks/useStableCallback";
import { findActivationProject } from "../desktopAppActivation";

export function DesktopAppActivationCoordinator() {
  const ready = useStartupReady();
  const createThread = useCreateProjectBackedDraftThread();
  const startThread = useStableCallback(createThread);
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
              if (disposed)
                throw new Error("Desktop activation was interrupted. Retry to reuse the project.");
              const api = ensureNativeApi();
              const { snapshot } = await api.orchestration.getStartupSnapshot();
              useStore.getState().syncStartupSnapshot(snapshot);
              if (disposed)
                throw new Error("Desktop activation was interrupted. Retry to reuse the project.");
              const originals = [
                request.path,
                ...useStore.getState().projects.map((project) => project.cwd),
              ];
              const resolved = await bridge.resolveActivationPaths?.(originals);
              if (disposed)
                throw new Error("Desktop activation was interrupted. Retry to reuse the project.");
              const paths = new Map(
                originals.map((value, index) => [value, resolved?.[index] ?? value]),
              );
              const project = findActivationProject(
                useStore.getState().projects,
                request.path,
                (value) => paths.get(value) ?? value,
              );
              const projectId = project?.id ?? newProjectId();
              if ((await bridge.isAppActivationPending?.(request.id)) === false)
                throw new Error("Desktop activation expired. Retry to reuse the project.");
              if (!project) {
                await api.orchestration.dispatchCommand({
                  type: "project.create",
                  commandId: newCommandId(),
                  projectId,
                  title: request.path.split(/[\\/]/).filter(Boolean).at(-1) ?? request.path,
                  workspaceRoot: request.path,
                  createdAt: new Date().toISOString(),
                });
                const result = await api.orchestration.getStartupSnapshot();
                useStore.getState().syncStartupSnapshot(result.snapshot);
              }
              if (disposed)
                throw new Error("Desktop activation was interrupted. Retry to reuse the project.");
              useStore.getState().setProjectExpanded(projectId, true);
              if ((await bridge.isAppActivationPending?.(request.id)) === false)
                throw new Error("Desktop activation expired. Retry to reuse the project.");
              const draft = await startThread(projectId);
              if (!draft) throw new Error("Could not start a new thread.");
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
  }, [ready, startThread]);
  return null;
}
