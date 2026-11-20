import type { ProjectId } from "@t3tools/contracts";
import { useCreateProjectBackedDraftThread } from "./useCreateProjectBackedDraftThread";
import { useStableCallback } from "./useStableCallback";
import { useStartupReady } from "../lib/startupReady";
import { ensureNativeApi } from "../nativeApi";
import { useStore } from "../store";
import { findActivationProject } from "../desktopAppActivation";
import { newCommandId, newProjectId } from "../lib/utils";

// Activations and drops share one lane, including across mounted consumers.
let opening: Promise<unknown> = Promise.resolve();

export function useOpenLocalWorkspace() {
  const ready = useStartupReady();
  const createThread = useCreateProjectBackedDraftThread();
  const open = useStableCallback((path: string, check: () => Promise<void> = async () => {}) => {
    const operation = opening
      .catch(() => {})
      .then(async () => {
        if (!ready) throw new Error("This computer's server is not connected yet.");
        const bridge = window.desktopBridge;
        if (!bridge) throw new Error("Opening local folders requires the desktop app.");
        await check();
        const api = ensureNativeApi();
        const { snapshot } = await api.orchestration.getStartupSnapshot();
        useStore.getState().syncStartupSnapshot(snapshot);
        await check();
        const originals = [path, ...useStore.getState().projects.map((project) => project.cwd)];
        const resolved = await bridge.resolveActivationPaths?.(originals);
        await check();
        const paths = new Map(originals.map((value, index) => [value, resolved?.[index] ?? value]));
        const project = findActivationProject(
          useStore.getState().projects,
          path,
          (value) => paths.get(value) ?? value,
        );
        const projectId = project?.id ?? newProjectId();
        if (!project) {
          await api.orchestration.dispatchCommand({
            type: "project.create",
            commandId: newCommandId(),
            projectId,
            title: path.split(/[\\/]/).filter(Boolean).at(-1) ?? path,
            workspaceRoot: path,
            createdAt: new Date().toISOString(),
          });
          const result = await api.orchestration.getStartupSnapshot();
          useStore.getState().syncStartupSnapshot(result.snapshot);
        }
        await check();
        useStore.getState().setProjectExpanded(projectId, true);
        if (!(await createThread(projectId as ProjectId)))
          throw new Error("Could not start a new thread.");
      });
    opening = operation;
    return operation;
  });
  return { ready, open };
}
