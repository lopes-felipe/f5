import type { TurnId } from "@t3tools/contracts";
import { splitPathAndPosition } from "../terminal-links";
import { relativePathForDisplay } from "./attachedFiles";

export function looksLikeAbsoluteFilePath(value: string): boolean {
  return value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value) || value.startsWith("\\\\");
}

export function normalizeFilePathForDiffLookup(
  filePath: string,
  workspaceRoot: string | undefined,
): {
  path: string;
  line: number | undefined;
  column: number | undefined;
  workspaceRelative: boolean;
} | null {
  const { path, line, column } = splitPathAndPosition(filePath);
  const normalized = relativePathForDisplay(path, workspaceRoot);
  if (!normalized) {
    return null;
  }
  return {
    path: normalized,
    line: line ? Number.parseInt(line, 10) : undefined,
    column: column ? Number.parseInt(column, 10) : undefined,
    workspaceRelative: !looksLikeAbsoluteFilePath(normalized),
  };
}

export function shouldOpenFileInDiffPanel(input: {
  parsedFilePath: {
    path: string;
    line: number | undefined;
    column: number | undefined;
    workspaceRelative: boolean;
  } | null;
  turnId: TurnId | undefined;
  diffFilePathsByTurnId: ReadonlyMap<TurnId, ReadonlySet<string>>;
}): boolean {
  const { parsedFilePath, turnId, diffFilePathsByTurnId } = input;
  if (!parsedFilePath?.workspaceRelative) {
    return false;
  }
  if (parsedFilePath.line || parsedFilePath.column) {
    return false;
  }
  if (!turnId) {
    return false;
  }
  return diffFilePathsByTurnId.get(turnId)?.has(parsedFilePath.path) ?? false;
}
