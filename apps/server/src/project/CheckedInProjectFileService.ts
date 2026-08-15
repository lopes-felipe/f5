import {
  CHECKED_IN_PROJECT_FILE_MAX_BYTES,
  F5_PROJECT_FILE_NAME,
  LEGACY_T3_PROJECT_FILE_NAME,
  type CheckedInProjectConfigDiagnostic,
  type CheckedInProjectFileName,
  type ProjectCheckedInConfig,
  type ProjectId,
} from "@t3tools/contracts";
import { parseCheckedInProjectFile } from "@t3tools/shared/checkedInProjectFile";

import {
  type WorkspaceAssetAuthorizer,
  WorkspaceAssetAuthorizationError,
  type WorkspaceAssetReader,
  WORKSPACE_FAVICON_MAX_BYTES,
} from "../WorkspaceAssetAuthorizer";

export interface CheckedInProjectFileService {
  readonly load: (projectId: ProjectId) => Promise<ProjectCheckedInConfig>;
}

function readFailureDiagnostic(
  sourceFile: CheckedInProjectFileName,
  error: unknown,
): CheckedInProjectConfigDiagnostic {
  if (error instanceof WorkspaceAssetAuthorizationError) {
    switch (error.failure) {
      case "too_large":
        return {
          field: "file",
          message: `${sourceFile} exceeds the 64 KiB project configuration limit.`,
        };
      case "invalid_path":
        return {
          field: "file",
          message: `${sourceFile} must be a regular file and may not be a symbolic link.`,
        };
      case "mime_mismatch":
        return { field: "file", message: `${sourceFile} must contain valid UTF-8 text.` };
      default:
        break;
    }
  }
  return { field: "file", message: `Unable to read ${sourceFile}.` };
}

export function makeCheckedInProjectFileService(
  authorizer: WorkspaceAssetAuthorizer,
): CheckedInProjectFileService {
  return {
    load: async (projectId) => {
      let reader: WorkspaceAssetReader;
      try {
        reader = await authorizer.forProject(projectId);
      } catch {
        return {
          projectId,
          sourceFile: null,
          defaultThreadEnvMode: null,
          iconPath: null,
          diagnostics: [
            { field: "file", message: "The registered project workspace is unavailable." },
          ],
        };
      }

      for (const sourceFile of [F5_PROJECT_FILE_NAME, LEGACY_T3_PROJECT_FILE_NAME] as const) {
        let raw: string;
        try {
          raw = await reader.readText({
            relativePath: sourceFile,
            maxBytes: CHECKED_IN_PROJECT_FILE_MAX_BYTES,
            rejectSymlink: true,
          });
        } catch (error) {
          if (error instanceof WorkspaceAssetAuthorizationError && error.failure === "not_found") {
            continue;
          }
          return {
            projectId,
            sourceFile,
            defaultThreadEnvMode: null,
            iconPath: null,
            diagnostics: [readFailureDiagnostic(sourceFile, error)],
          };
        }

        const parsed = parseCheckedInProjectFile(raw);
        const diagnostics = [...parsed.diagnostics];
        let iconPath = parsed.iconPath;
        if (iconPath !== null) {
          try {
            await reader.readImage({
              relativePath: iconPath,
              maxBytes: WORKSPACE_FAVICON_MAX_BYTES,
              rejectSymlink: true,
            });
          } catch {
            diagnostics.push({
              field: "iconPath",
              message: "iconPath must reference a supported image inside the project workspace.",
            });
            iconPath = null;
          }
        }

        return {
          projectId,
          sourceFile,
          defaultThreadEnvMode: parsed.defaultThreadEnvMode,
          iconPath,
          diagnostics,
        };
      }

      return {
        projectId,
        sourceFile: null,
        defaultThreadEnvMode: null,
        iconPath: null,
        diagnostics: [],
      };
    },
  };
}
