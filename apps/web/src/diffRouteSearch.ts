import { OrchestrationFileChangeId, TurnId } from "@t3tools/contracts";

export interface DiffRouteSearch {
  timelineEntryId?: string | undefined;
  timelineEntryKind?: "message" | "activity" | undefined;
  diff?: "1" | undefined;
  diffTurnId?: TurnId | undefined;
  diffFileChangeId?: OrchestrationFileChangeId | undefined;
  diffFilePath?: string | undefined;
  diffScope?: "working-tree" | "branch-range" | undefined;
  diffBaseRef?: string | undefined;
  fileViewPath?: string | undefined;
  fileLine?: number | undefined;
  fileEndLine?: number | undefined;
  fileColumn?: number | undefined;
}

function isDiffOpenValue(value: unknown): boolean {
  return value === "1" || value === 1 || value === true;
}

function normalizeSearchString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
}

function normalizeSearchPositiveInt(value: unknown): number | undefined {
  if (typeof value === "number") {
    return Number.isInteger(value) && value > 0 ? value : undefined;
  }
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim();
  if (!/^\d+$/.test(normalized)) {
    return undefined;
  }
  const parsed = Number.parseInt(normalized, 10);
  return parsed > 0 ? parsed : undefined;
}

export function stripDiffSearchParams<T extends Record<string, unknown>>(
  params: T,
): Omit<
  T,
  | "diff"
  | "diffTurnId"
  | "diffFileChangeId"
  | "diffFilePath"
  | "diffScope"
  | "diffBaseRef"
  | "fileViewPath"
  | "fileLine"
  | "fileEndLine"
  | "fileColumn"
> {
  const {
    diff: _diff,
    diffTurnId: _diffTurnId,
    diffFileChangeId: _diffFileChangeId,
    diffFilePath: _diffFilePath,
    diffScope: _diffScope,
    diffBaseRef: _diffBaseRef,
    fileViewPath: _fileViewPath,
    fileLine: _fileLine,
    fileEndLine: _fileEndLine,
    fileColumn: _fileColumn,
    ...rest
  } = params;
  return rest as Omit<
    T,
    | "diff"
    | "diffTurnId"
    | "diffFileChangeId"
    | "diffFilePath"
    | "diffScope"
    | "diffBaseRef"
    | "fileViewPath"
    | "fileLine"
    | "fileEndLine"
    | "fileColumn"
  >;
}

export function clearDiffSearchParams<T extends Record<string, unknown>>(
  params: T,
): Omit<
  T,
  | "diff"
  | "diffTurnId"
  | "diffFileChangeId"
  | "diffFilePath"
  | "diffScope"
  | "diffBaseRef"
  | "fileViewPath"
  | "fileLine"
  | "fileEndLine"
  | "fileColumn"
> &
  DiffRouteSearch {
  const rest = stripDiffSearchParams(params);
  return {
    ...rest,
    diff: undefined,
    diffTurnId: undefined,
    diffFileChangeId: undefined,
    diffFilePath: undefined,
    diffScope: undefined,
    diffBaseRef: undefined,
    fileViewPath: undefined,
    fileLine: undefined,
    fileEndLine: undefined,
    fileColumn: undefined,
  };
}

export function clearTurnDiffSearchParams<T extends Record<string, unknown>>(
  params: T,
): Omit<
  T,
  "diff" | "diffTurnId" | "diffFileChangeId" | "diffFilePath" | "diffScope" | "diffBaseRef"
> &
  Pick<
    DiffRouteSearch,
    "diff" | "diffTurnId" | "diffFileChangeId" | "diffFilePath" | "diffScope" | "diffBaseRef"
  > {
  const {
    diff: _diff,
    diffTurnId: _diffTurnId,
    diffFileChangeId: _diffFileChangeId,
    diffFilePath: _diffFilePath,
    diffScope: _diffScope,
    diffBaseRef: _diffBaseRef,
    ...rest
  } = params;
  return {
    ...rest,
    diff: undefined,
    diffTurnId: undefined,
    diffFileChangeId: undefined,
    diffFilePath: undefined,
    diffScope: undefined,
    diffBaseRef: undefined,
  };
}

export function clearFileViewSearchParams<T extends Record<string, unknown>>(
  params: T,
): Omit<T, "fileViewPath" | "fileLine" | "fileEndLine" | "fileColumn"> &
  Pick<DiffRouteSearch, "fileViewPath" | "fileLine" | "fileEndLine" | "fileColumn"> {
  const {
    fileViewPath: _fileViewPath,
    fileLine: _fileLine,
    fileEndLine: _fileEndLine,
    fileColumn: _fileColumn,
    ...rest
  } = params;
  return {
    ...rest,
    fileViewPath: undefined,
    fileLine: undefined,
    fileEndLine: undefined,
    fileColumn: undefined,
  };
}

export function parseDiffRouteSearch(search: Record<string, unknown>): DiffRouteSearch {
  const timelineEntryId = normalizeSearchString(search.timelineEntryId);
  const timelineEntryKind =
    timelineEntryId &&
    (search.timelineEntryKind === "message" || search.timelineEntryKind === "activity")
      ? search.timelineEntryKind
      : undefined;
  const diff = isDiffOpenValue(search.diff) ? "1" : undefined;
  const diffTurnIdRaw = diff ? normalizeSearchString(search.diffTurnId) : undefined;
  const diffTurnId = diffTurnIdRaw ? TurnId.makeUnsafe(diffTurnIdRaw) : undefined;
  const diffFileChangeIdRaw = diff ? normalizeSearchString(search.diffFileChangeId) : undefined;
  const diffFileChangeId = diffFileChangeIdRaw
    ? OrchestrationFileChangeId.makeUnsafe(diffFileChangeIdRaw)
    : undefined;
  const diffFilePath = diff ? normalizeSearchString(search.diffFilePath) : undefined;
  const diffScope =
    diff && (search.diffScope === "working-tree" || search.diffScope === "branch-range")
      ? search.diffScope
      : undefined;
  const diffBaseRef =
    diffScope === "branch-range" ? normalizeSearchString(search.diffBaseRef) : undefined;
  const fileViewPath = normalizeSearchString(search.fileViewPath);
  const fileLine = fileViewPath ? normalizeSearchPositiveInt(search.fileLine) : undefined;
  const normalizedFileEndLine = fileLine
    ? normalizeSearchPositiveInt(search.fileEndLine)
    : undefined;
  const fileEndLine =
    fileLine && normalizedFileEndLine && normalizedFileEndLine >= fileLine
      ? normalizedFileEndLine
      : undefined;
  const fileColumn = fileLine ? normalizeSearchPositiveInt(search.fileColumn) : undefined;

  return {
    ...(timelineEntryId ? { timelineEntryId } : {}),
    ...(timelineEntryKind ? { timelineEntryKind } : {}),
    ...(diff ? { diff } : {}),
    ...(diffTurnId ? { diffTurnId } : {}),
    ...(diffFileChangeId ? { diffFileChangeId } : {}),
    ...(diffFilePath ? { diffFilePath } : {}),
    ...(diffScope ? { diffScope } : {}),
    ...(diffBaseRef ? { diffBaseRef } : {}),
    ...(fileViewPath ? { fileViewPath } : {}),
    ...(fileLine ? { fileLine } : {}),
    ...(fileEndLine ? { fileEndLine } : {}),
    ...(fileColumn ? { fileColumn } : {}),
  };
}
