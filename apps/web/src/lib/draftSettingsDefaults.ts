import {
  DEFAULT_SERVER_SETTINGS,
  type ProjectId,
  type RuntimeMode,
  type ServerSettings,
} from "@t3tools/contracts";
let globalSettings = DEFAULT_SERVER_SETTINGS;
const projectDefaults = new Map<ProjectId, RuntimeMode>();
export function rememberDraftSettings(settings: ServerSettings, projectId?: ProjectId) {
  if (projectId) {
    projectDefaults.delete(projectId);
    projectDefaults.set(projectId, settings.defaultRuntimeMode);
    if (projectDefaults.size > 100) projectDefaults.delete(projectDefaults.keys().next().value!);
  } else {
    globalSettings = settings;
  }
}
export function defaultDraftRuntimeMode(projectId: ProjectId) {
  return (
    globalSettings.projectSettingsOverrides[projectId]?.defaultRuntimeMode ??
    projectDefaults.get(projectId) ??
    "approval-required"
  );
}

export function cachedGlobalDraftSettings() {
  return globalSettings;
}
