import {
  DEFAULT_SERVER_SETTINGS,
  type ProjectId,
  type RuntimeMode,
  type ServerSettings,
} from "@t3tools/contracts";
let globalDefault = DEFAULT_SERVER_SETTINGS.defaultRuntimeMode;
const projectDefaults = new Map<ProjectId, RuntimeMode>();
export function rememberDraftSettings(settings: ServerSettings, projectId?: ProjectId) {
  if (projectId) {
    projectDefaults.delete(projectId);
    projectDefaults.set(projectId, settings.defaultRuntimeMode);
    if (projectDefaults.size > 100) projectDefaults.delete(projectDefaults.keys().next().value!);
  } else {
    globalDefault = settings.defaultRuntimeMode;
    projectDefaults.clear();
  }
}
export function defaultDraftRuntimeMode(projectId: ProjectId) {
  return projectDefaults.get(projectId) ?? globalDefault;
}
