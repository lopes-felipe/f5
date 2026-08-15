import { Schema } from "effect";

import { ProjectId, TrimmedNonEmptyString } from "./baseSchemas";
import { ThreadEnvMode } from "./threadEnvMode";

export const F5_PROJECT_FILE_NAME = "f5.json";
export const LEGACY_T3_PROJECT_FILE_NAME = "t3.json";
export const CHECKED_IN_PROJECT_FILE_MAX_BYTES = 64 * 1024;
export const CHECKED_IN_PROJECT_ICON_PATH_MAX_LENGTH = 512;

export const CheckedInProjectIconPath = TrimmedNonEmptyString.check(
  Schema.isMaxLength(CHECKED_IN_PROJECT_ICON_PATH_MAX_LENGTH),
);
export type CheckedInProjectIconPath = typeof CheckedInProjectIconPath.Type;

export const CheckedInProjectFile = Schema.Struct({
  $schema: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(2_048))),
  defaultThreadEnvMode: Schema.optionalKey(ThreadEnvMode),
  iconPath: Schema.optionalKey(CheckedInProjectIconPath),
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
  "iconPath",
  "scripts",
  "mcpServers",
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
  sourceFile: Schema.NullOr(CheckedInProjectFileName),
  defaultThreadEnvMode: Schema.NullOr(ThreadEnvMode),
  iconPath: Schema.NullOr(CheckedInProjectIconPath),
  diagnostics: Schema.Array(CheckedInProjectConfigDiagnostic),
});
export type ProjectCheckedInConfig = typeof ProjectCheckedInConfig.Type;
