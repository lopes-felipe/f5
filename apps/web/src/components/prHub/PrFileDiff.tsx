import { OpenLinkAnchor } from "../OpenLinkAnchor";
import {
  isPrReviewAnchorInPatch,
  substantivePrPatch,
  type PrReviewAnchor,
} from "@t3tools/shared/prReview";
import { useMemo } from "react";
import { SearchableDiffView } from "../SearchableDiffView";
import type { PrHubChangedFile } from "@t3tools/contracts";
import { useAppSettings } from "../../appSettings";
import { useTheme } from "../../hooks/useTheme";
import { buildFileDiffRenderKey, DIFF_PANEL_UNSAFE_CSS } from "../../lib/diffPatch";
import { getRenderablePrFilePatch, isPurePrFileRename } from "../../lib/prFilePatch";
import { PREFERRED_HIGHLIGHTER, resolveDiffThemeName } from "../../lib/diffRendering";
import { DiffSurfaceBoundary } from "../DiffSurfaceBoundary";

export function PrFileDiff({
  file,
  scope,
  url,
  onComment,
}: {
  file: PrHubChangedFile;
  scope: string;
  url: string;
  onComment?: ((anchor: PrReviewAnchor) => void) | undefined;
}) {
  const { settings } = useAppSettings();
  const { resolvedTheme } = useTheme();
  const pureRename = isPurePrFileRename(file);
  const displayPatch = useMemo(
    () =>
      file.patch && settings.diffIgnoreWhitespace && !pureRename
        ? substantivePrPatch(file.patch)
        : file.patch,
    [file.patch, settings.diffIgnoreWhitespace, pureRename],
  );
  const patch = useMemo(
    () => getRenderablePrFilePatch(file, displayPatch, scope),
    [file, displayPatch, scope],
  );
  if (file.patchStatus === "available" && file.patch && displayPatch === null)
    return (
      <p className="p-3 text-sm text-muted-foreground">
        Only whitespace changes. Turn off whitespace filtering to inspect them.
      </p>
    );
  if ((file.patchStatus !== "available" && !pureRename) || !patch || patch.kind !== "files") {
    return (
      <p className="p-3 text-sm text-muted-foreground">
        {file.patchStatus === "truncated"
          ? "GitHub returned an incomplete patch."
          : "A renderable text patch is unavailable for this file."}{" "}
        <OpenLinkAnchor href={url} target="_blank" rel="noreferrer" className="underline">
          Open on GitHub
        </OpenLinkAnchor>
      </p>
    );
  }
  return (
    <DiffSurfaceBoundary fallback={<p className="p-3 text-sm">Loading diff…</p>}>
      <SearchableDiffView
        className="diff-render-surface h-[32rem] overflow-auto"
        files={patch.files.map((diff) => ({
          id: buildFileDiffRenderKey(diff),
          fileDiff: diff,
          collapsed: false,
        }))}
        options={{
          diffStyle: settings.diffRenderMode === "split" ? "split" : "unified",
          lineDiffType: "none",
          ...(onComment
            ? {
                onLineNumberClick: (event) => {
                  const anchor: PrReviewAnchor = {
                    path: file.path,
                    line: event.lineNumber,
                    side:
                      "annotationSide" in event && event.annotationSide === "deletions"
                        ? "LEFT"
                        : "RIGHT",
                  };
                  if (file.patch && isPrReviewAnchorInPatch(anchor, file.patch)) onComment(anchor);
                },
              }
            : {}),
          overflow: settings.diffWordWrap ? "wrap" : "scroll",
          theme: resolveDiffThemeName(resolvedTheme),
          preferredHighlighter: PREFERRED_HIGHLIGHTER,
          themeType: resolvedTheme,
          unsafeCSS: DIFF_PANEL_UNSAFE_CSS,
        }}
      />
    </DiffSurfaceBoundary>
  );
}
