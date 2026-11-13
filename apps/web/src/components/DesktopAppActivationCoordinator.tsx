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
              const api = ensureNativeApi();
              const { snapshot } = await api.orchestration.getStartupSnapshot();
              useStore.getState().syncStartupSnapshot(snapshot);
              const project = findActivationProject(
                useStore.getState().projects,
                request.path,
                bridge.resolveRealPath,
              );
              const projectId = project?.id ?? newProjectId();
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
              if (disposed) throw new Error("The desktop window was closed.");
              useStore.getState().setProjectExpanded(projectId, true);
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
      }
    };
    const run = () => {
      void take().catch(() => {});
    };
    run();
    const unsubscribe = bridge.onAppActivationsAvailable?.(run);
    window.addEventListener("focus", run);
    return () => {
      disposed = true;
      unsubscribe?.();
      window.removeEventListener("focus", run);
    };
  }, [ready, startThread]);
  return null;
}
