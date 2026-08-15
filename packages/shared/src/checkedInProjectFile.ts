import {
  CheckedInProjectIconPath,
  ThreadEnvMode,
  type CheckedInProjectConfigDiagnostic,
  type CheckedInProjectIconPath as CheckedInProjectIconPathType,
  type ThreadEnvMode as ThreadEnvModeType,
} from "@t3tools/contracts";
import { Exit, Schema } from "effect";

import { fromLenientJson } from "./schemaJson";

export interface ParsedCheckedInProjectFile {
  readonly defaultThreadEnvMode: ThreadEnvModeType | null;
  readonly iconPath: CheckedInProjectIconPathType | null;
  readonly diagnostics: ReadonlyArray<CheckedInProjectConfigDiagnostic>;
}

const decodeUnknownJson = Schema.decodeUnknownExit(fromLenientJson(Schema.Unknown));
const decodeThreadEnvMode = Schema.decodeUnknownExit(ThreadEnvMode);
const decodeIconPath = Schema.decodeUnknownExit(CheckedInProjectIconPath);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasSafeRelativePathShape(value: string): boolean {
  const normalized = value.replaceAll("\\", "/");
  if (normalized.startsWith("/") || /^[a-z]:\//iu.test(normalized) || normalized.includes("\0")) {
    return false;
  }
  return normalized.split("/").every((segment) => segment !== "..");
}

export function parseCheckedInProjectFile(raw: string): ParsedCheckedInProjectFile {
  const decoded = decodeUnknownJson(raw);
  if (Exit.isFailure(decoded) || !isRecord(decoded.value)) {
    return {
      defaultThreadEnvMode: null,
      iconPath: null,
      diagnostics: [
        { field: "file", message: "Project configuration is not a valid JSON object." },
      ],
    };
  }

  const diagnostics: CheckedInProjectConfigDiagnostic[] = [];
  let defaultThreadEnvMode: ThreadEnvModeType | null = null;
  let iconPath: CheckedInProjectIconPathType | null = null;

  if (
    decoded.value.$schema !== undefined &&
    (typeof decoded.value.$schema !== "string" || decoded.value.$schema.length > 2_048)
  ) {
    diagnostics.push({
      field: "$schema",
      message: "$schema must be a string of at most 2048 characters when provided.",
    });
  }

  if (decoded.value.defaultThreadEnvMode !== undefined) {
    const field = decodeThreadEnvMode(decoded.value.defaultThreadEnvMode);
    if (Exit.isSuccess(field)) {
      defaultThreadEnvMode = field.value;
    } else {
      diagnostics.push({
        field: "defaultThreadEnvMode",
        message: 'defaultThreadEnvMode must be either "local" or "worktree".',
      });
    }
  }

  if (decoded.value.iconPath !== undefined) {
    const field = decodeIconPath(decoded.value.iconPath);
    if (Exit.isSuccess(field) && hasSafeRelativePathShape(field.value)) {
      iconPath = field.value;
    } else {
      diagnostics.push({
        field: "iconPath",
        message: "iconPath must be a workspace-relative path of at most 512 characters.",
      });
    }
  }

  if (decoded.value.scripts !== undefined) {
    diagnostics.push({
      field: "scripts",
      message: "Repository-defined scripts are not loaded because they require explicit approval.",
    });
  }
  if (decoded.value.mcpServers !== undefined || decoded.value.mcp !== undefined) {
    diagnostics.push({
      field: "mcpServers",
      message:
        "Repository-defined MCP servers are not loaded because they require explicit approval.",
    });
  }

  return { defaultThreadEnvMode, iconPath, diagnostics };
}
