import { OpenLinkAnchor } from "../OpenLinkAnchor";
import {
  isPrReviewAnchorInPatch,
  substantivePrPatch,
  type PrReviewAnchor,
} from "@t3tools/shared/prReview";
import { useMemo, useState } from "react";
import { SearchableDiffView } from "../SearchableDiffView";
import type { PrHubChangedFile } from "@t3tools/contracts";
import { useAppSettings } from "../../appSettings";
import { useTheme } from "../../hooks/useTheme";
import { buildFileDiffRenderKey, DIFF_PANEL_UNSAFE_CSS } from "../../lib/diffPatch";
import { getRenderablePrFilePatch, isPurePrFileRename } from "../../lib/prFilePatch";
import { PREFERRED_HIGHLIGHTER, resolveDiffThemeName } from "../../lib/diffRendering";
import { DiffSurfaceBoundary } from "../DiffSurfaceBoundary";
import { Button } from "../ui/button";

export function PrFileDiff({
  file: listedFile,
  scope,
  url,
  onComment,
  loadDiff,
  forgeLabel = "GitHub",
}: {
  file: PrHubChangedFile;
  scope: string;
  url: string;
  onComment?: ((anchor: PrReviewAnchor) => void) | undefined;
  loadDiff?: (() => Promise<PrHubChangedFile>) | undefined;
  forgeLabel?: string;
}) {
  const [loadedFile, setLoadedFile] = useState<PrHubChangedFile | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const file = useMemo(
    () =>
      loadedFile?.patch
        ? {
            ...listedFile,
            patch: loadedFile.patch,
            patchStatus: "available" as const,
            hasShortenedLines: loadedFile.hasShortenedLines === true,
          }
        : listedFile,
    [listedFile, loadedFile],
  );
  const { settings } = useAppSettings();
  const { resolvedTheme } = useTheme();
  const pureRename = isPurePrFileRename(file);
  const missingDiff =
    (file.patchStatus === "truncated" || !file.patch) &&
    file.patchStatus !== "available" &&
    !pureRename &&
    file.additions + file.deletions > 0;
  const displayPatch = useMemo(
    () =>
      file.patch && settings.diffIgnoreWhitespace && !pureRename && !file.hasShortenedLines
        ? substantivePrPatch(file.patch)
        : file.patch,
    [file.patch, file.hasShortenedLines, settings.diffIgnoreWhitespace, pureRename],
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
        {missingDiff && (loadDiff || file.patchStatus === "truncated")
          ? "Diff too large to display."
          : "A renderable text patch is unavailable for this file."}{" "}
        {loadDiff && missingDiff ? (
          <Button
            size="sm"
            variant="outline"
            disabled={loading}
            onClick={() => {
              setLoading(true);
              setLoadError(null);
              void loadDiff()
                .then(setLoadedFile)
                .catch((error: unknown) =>
                  setLoadError(error instanceof Error ? error.message : "Could not load diff."),
                )
                .finally(() => setLoading(false));
            }}
          >
            {loading ? "Loading…" : "Load diff"}
          </Button>
        ) : null}{" "}
        <OpenLinkAnchor href={url} target="_blank" rel="noreferrer" className="underline">
          Open on {forgeLabel}
        </OpenLinkAnchor>
        {loadError ? (
          <span className="block text-destructive" role="alert">
            {loadError}
          </span>
        ) : null}
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
          ...(onComment && !loadedFile
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
