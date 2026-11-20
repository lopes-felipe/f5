import type { ProjectId } from "@t3tools/contracts";
import { ensureNativeApi } from "../nativeApi";
import { useStore } from "../store";
import { findActivationProject } from "../desktopAppActivation";
import { newCommandId, newProjectId } from "./utils";

/** Loaded on activation or folder drop, not on the application's startup path. */
export async function openLocalWorkspace(
  path: string,
  createThread: (projectId: ProjectId) => Promise<unknown>,
  check: () => Promise<void>,
) {
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
  if (!(await createThread(projectId))) throw new Error("Could not start a new thread.");
}
