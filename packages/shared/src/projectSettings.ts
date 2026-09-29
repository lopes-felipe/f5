import { resolveTextGenerationProvider } from "./serverSettings";
import {
  DEFAULT_SERVER_SETTINGS,
  PROJECT_SCOPED_SERVER_SETTING_KEYS,
  type ProjectId,
  type ProjectSettingsOverrides,
  type ProjectSettingsResult,
  type ServerSettings,
  type ThreadEnvMode,
} from "@t3tools/contracts";

/** Resolve only the approved project-scoped keys. Explicit false and null are values. */
export function resolveProjectSettings(input: {
  global?: ServerSettings | undefined;
  projectId: ProjectId;
  legacyEnvMode?: ThreadEnvMode | null;
  checkedIn?: ProjectSettingsOverrides;
  sourceFile?: "f5.json" | "t3.json" | null;
}): ProjectSettingsResult {
  const global = input.global ?? DEFAULT_SERVER_SETTINGS;
  const overrides = Object.hasOwn(global.projectSettingsOverrides, input.projectId)
    ? global.projectSettingsOverrides[input.projectId]!
    : {};
  const settings = { ...global };
  const sources = {} as ProjectSettingsResult["sources"];
  for (const key of PROJECT_SCOPED_SERVER_SETTING_KEYS) {
    let value: unknown = global[key];
    let source: ProjectSettingsResult["sources"][typeof key] = input.global ? "global" : "default";
    if (input.checkedIn?.[key] !== undefined) {
      value =
        key === "sourceControlWriting"
          ? { ...global.sourceControlWriting, ...input.checkedIn.sourceControlWriting }
          : input.checkedIn[key];
      source = input.sourceFile ?? "f5.json";
    }
    if (key === "defaultThreadEnvMode" && input.legacyEnvMode != null) {
      value = input.legacyEnvMode;
      source = "legacy-project";
    }
    if (overrides[key] !== undefined) {
      value =
        key === "sourceControlWriting"
          ? {
              ...(value as ServerSettings["sourceControlWriting"]),
              ...overrides.sourceControlWriting,
            }
          : overrides[key];
      source = "project";
    }
    Object.assign(settings, { [key]: value });
    Object.assign(sources, { [key]: source });
  }
  return { settings: resolveTextGenerationProvider(settings), sources, overrides };
}
