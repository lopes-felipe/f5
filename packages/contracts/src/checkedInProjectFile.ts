import { Schema } from "effect";

import { ProjectId, ThreadId, TrimmedNonEmptyString } from "./baseSchemas";
import { ProjectSettingsOverrides } from "./settings";
import { ThreadEnvMode } from "./threadEnvMode";
import { UpstreamProjectConfig } from "./upstreamPorts";

export const F5_PROJECT_FILE_NAME = "f5.json";
export const LEGACY_T3_PROJECT_FILE_NAME = "t3.json";
export const CHECKED_IN_PROJECT_FILE_MAX_BYTES = 64 * 1024;
export const CHECKED_IN_PROJECT_ICON_PATH_MAX_LENGTH = 512;

export const CheckedInProjectIconPath = TrimmedNonEmptyString.check(
  Schema.isMaxLength(CHECKED_IN_PROJECT_ICON_PATH_MAX_LENGTH),
);
export type CheckedInProjectIconPath = typeof CheckedInProjectIconPath.Type;

export const ProjectIgnoredRepositories = Schema.Array(
  TrimmedNonEmptyString.check(Schema.isMaxLength(512)),
).check(Schema.isMaxLength(128));
export type ProjectIgnoredRepositories = typeof ProjectIgnoredRepositories.Type;

export const CheckedInProjectFile = Schema.Struct({
  $schema: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(2_048))),
  iconPath: Schema.optionalKey(CheckedInProjectIconPath),
  upstream: Schema.optionalKey(UpstreamProjectConfig),
  ignoreRepositories: Schema.optionalKey(ProjectIgnoredRepositories),
  ...ProjectSettingsOverrides.fields,
});
export type CheckedInProjectFile = typeof CheckedInProjectFile.Type;

export const CheckedInProjectFileName = Schema.Literals([
  F5_PROJECT_FILE_NAME,
  LEGACY_T3_PROJECT_FILE_NAME,
]);
export type CheckedInProjectFileName = typeof CheckedInProjectFileName.Type;

export const CheckedInProjectConfigDiagnosticField = Schema.Literals([
  "file",
  "$schema",
  "defaultThreadEnvMode",
  "settings",
  "worktreeSubmodules",
  "iconPath",
  "scripts",
  "mcpServers",
  "upstream",
  "ignoreRepositories",
]);
export type CheckedInProjectConfigDiagnosticField =
  typeof CheckedInProjectConfigDiagnosticField.Type;

export const CheckedInProjectConfigDiagnostic = Schema.Struct({
  field: CheckedInProjectConfigDiagnosticField,
  message: TrimmedNonEmptyString,
});
export type CheckedInProjectConfigDiagnostic = typeof CheckedInProjectConfigDiagnostic.Type;

export const ProjectGetCheckedInConfigInput = Schema.Struct({
  projectId: ProjectId,
});
export type ProjectGetCheckedInConfigInput = typeof ProjectGetCheckedInConfigInput.Type;

export const ProjectCheckedInConfig = Schema.Struct({
  projectId: ProjectId,
  settings: Schema.optionalKey(ProjectSettingsOverrides),
  sourceFile: Schema.NullOr(CheckedInProjectFileName),
  defaultThreadEnvMode: Schema.NullOr(ThreadEnvMode),
  iconPath: Schema.NullOr(CheckedInProjectIconPath),
  upstream: Schema.NullOr(UpstreamProjectConfig),
  ignoreRepositories: Schema.optionalKey(ProjectIgnoredRepositories),
  diagnostics: Schema.Array(CheckedInProjectConfigDiagnostic),
});
export type ProjectCheckedInConfig = typeof ProjectCheckedInConfig.Type;

export const ProjectListRepositoriesInput = Schema.Struct({
  projectId: ProjectId,
  threadId: Schema.optionalKey(ThreadId),
});
export type ProjectListRepositoriesInput = typeof ProjectListRepositoriesInput.Type;
export const ProjectSetRepositoryInput = Schema.Struct({
  projectId: ProjectId,
  path: TrimmedNonEmptyString.check(Schema.isMaxLength(2048)),
  tracked: Schema.Boolean,
});
export type ProjectSetRepositoryInput = typeof ProjectSetRepositoryInput.Type;

export const ProjectRepository = Schema.Struct({
  path: TrimmedNonEmptyString,
  relativePath: TrimmedNonEmptyString,
  submodule: Schema.optionalKey(Schema.Literal(true)),
  externalSource: Schema.optionalKey(TrimmedNonEmptyString),
});
export type ProjectRepository = typeof ProjectRepository.Type;
