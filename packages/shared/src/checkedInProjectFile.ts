import {
  ProjectSettingsOverrides,
  CheckedInProjectIconPath,
  ThreadEnvMode,
  UpstreamProjectConfig,
  type CheckedInProjectConfigDiagnostic,
  type CheckedInProjectIconPath as CheckedInProjectIconPathType,
  type ThreadEnvMode as ThreadEnvModeType,
  type UpstreamProjectConfig as UpstreamProjectConfigType,
} from "@t3tools/contracts";
import { Exit, Schema } from "effect";

import { fromLenientJson } from "./schemaJson";

export interface ParsedCheckedInProjectFile {
  readonly settings?: ProjectSettingsOverrides;
  readonly defaultThreadEnvMode: ThreadEnvModeType | null;
  readonly iconPath: CheckedInProjectIconPathType | null;
  readonly upstream: UpstreamProjectConfigType | null;
  readonly diagnostics: ReadonlyArray<CheckedInProjectConfigDiagnostic>;
}

const decodeUnknownJson = Schema.decodeUnknownExit(fromLenientJson(Schema.Unknown));
const decodeThreadEnvMode = Schema.decodeUnknownExit(ThreadEnvMode);
const decodeIconPath = Schema.decodeUnknownExit(CheckedInProjectIconPath);
const decodeUpstream = Schema.decodeUnknownExit(UpstreamProjectConfig);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function hasSafeRelativePathShape(value: string): boolean {
  const normalized = value.replaceAll("\\", "/");
  if (normalized.startsWith("/") || /^[a-z]:/iu.test(normalized) || normalized.includes("\0")) {
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
      upstream: null,
      diagnostics: [
        { field: "file", message: "Project configuration is not a valid JSON object." },
      ],
    };
  }

  const diagnostics: CheckedInProjectConfigDiagnostic[] = [];
  let defaultThreadEnvMode: ThreadEnvModeType | null = null;
  let iconPath: CheckedInProjectIconPathType | null = null;
  let upstream: UpstreamProjectConfigType | null = null;

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

  if (decoded.value.upstream !== undefined) {
    const field = decodeUpstream(decoded.value.upstream);
    if (Exit.isSuccess(field) && hasSafeRelativePathShape(field.value.ledgerDir)) {
      upstream = field.value;
    } else {
      diagnostics.push({
        field: "upstream",
        message:
          "upstream needs a https://github.com/<owner>/<repo> repository, a plain remote name, a plain branch name, and a normalized workspace-relative ledgerDir.",
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

  const settings: ProjectSettingsOverrides = {};
  for (const [key, schema] of Object.entries(ProjectSettingsOverrides.fields)) {
    if (decoded.value[key] === undefined) continue;
    const field = Schema.decodeUnknownExit(Schema.Struct({ [key]: schema }))({
      [key]: decoded.value[key],
    });
    if (Exit.isSuccess(field)) Object.assign(settings, field.value);
    else if (key !== "defaultThreadEnvMode")
      diagnostics.push({ field: "settings", message: `Invalid value for ${key}.` });
  }
  return { defaultThreadEnvMode, iconPath, upstream, diagnostics, settings };
}
