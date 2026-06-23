import type { ThreadId } from "@t3tools/contracts";
import {
  clearFileViewSearchParams,
  clearTurnDiffSearchParams,
  parseDiffRouteSearch,
} from "./diffRouteSearch";
import {
  type OpenFileSurfaceInput,
  type RightPanelSurface,
  useRightPanelStore,
} from "./rightPanelStore";

export function clearSearchParamsForSurface<T extends Record<string, unknown>>(
  params: T,
  surface: RightPanelSurface,
): Record<string, unknown> {
  const parsed = parseDiffRouteSearch(params);
  if (surface.kind === "diff" && parsed.diff === "1") {
    return clearTurnDiffSearchParams(params);
  }
  if (surface.kind === "file" && parsed.fileViewPath === surface.relativePath) {
    return clearFileViewSearchParams(params);
  }
  return params;
}

export function setSearchParamsForSurface<T extends Record<string, unknown>>(
  params: T,
  surface: RightPanelSurface,
): Record<string, unknown> {
  if (surface.kind === "diff") {
    return {
      ...clearFileViewSearchParams(params),
      diff: "1",
    };
  }
  if (surface.kind === "file") {
    const withoutCurrentFile = clearFileViewSearchParams(params);
    return {
      ...withoutCurrentFile,
      fileViewPath: surface.relativePath,
      ...(surface.line ? { fileLine: surface.line } : {}),
      ...(surface.endLine ? { fileEndLine: surface.endLine } : {}),
      ...(surface.column ? { fileColumn: surface.column } : {}),
    };
  }
  return params;
}

export function openFileRightPanelSurface(
  threadId: ThreadId,
  input: OpenFileSurfaceInput,
): RightPanelSurface {
  return useRightPanelStore.getState().openFile(threadId, input);
}
