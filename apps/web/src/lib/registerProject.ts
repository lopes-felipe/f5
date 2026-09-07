import { DEFAULT_MODEL_BY_PROVIDER, type ProjectId } from "@t3tools/contracts";
import { ensureNativeApi } from "../nativeApi";
import { useStore } from "../store";
import { newCommandId, newProjectId } from "./utils";

const pathKey = (cwd: string) => {
  const normalized = cwd.replace(/\\/g, "/").replace(/\/+$/, "");
  return /^(?:[a-z]:|\/\/)/i.test(normalized) ? normalized.toLowerCase() : normalized;
};
type Project = ReturnType<typeof useStore.getState>["projects"][number];
const registrations = new Map<string, Promise<Project>>();

export function waitForRegisteredProject(projectId: ProjectId): Promise<Project> {
  const current = useStore.getState().projects.find((project) => project.id === projectId);
  if (current) return Promise.resolve(current);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      unsubscribe();
      reject(
        new Error("Project was added, but F5 has not received the update. Refresh and retry."),
      );
    }, 10000);
    const check = () => {
      const project = useStore.getState().projects.find((item) => item.id === projectId);
      if (project) {
        clearTimeout(timer);
        unsubscribe();
        resolve(project);
      }
    };
    const unsubscribe = useStore.subscribe(check);
    check();
  });
}

/** Register only the project. The caller decides which thread or PR action follows. */
export function registerProjectFromPath(cwd: string, title?: string): Promise<Project> {
  const key = pathKey(cwd);
  const existing = useStore.getState().projects.find((project) => pathKey(project.cwd) === key);
  if (existing) return Promise.resolve(existing);
  const pending = registrations.get(key);
  if (pending) return pending;
  const work = (async () => {
    const projectId = newProjectId();
    await ensureNativeApi().orchestration.dispatchCommand({
      type: "project.create",
      commandId: newCommandId(),
      projectId,
      title: title ?? cwd.split(/[/\\]/).filter(Boolean).at(-1) ?? cwd,
      workspaceRoot: cwd,
      defaultModel: DEFAULT_MODEL_BY_PROVIDER.codex,
      createdAt: new Date().toISOString(),
    });
    return waitForRegisteredProject(projectId);
  })();
  registrations.set(key, work);
  void work
    .finally(() => {
      if (registrations.get(key) === work) registrations.delete(key);
    })
    .catch(() => undefined);
  return work;
}
