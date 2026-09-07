import {
  isPrReviewAnchorInPatch,
  substantivePrPatch,
  type PrReviewAnchor,
} from "@t3tools/shared/prReview";
import { useMemo } from "react";
import { FileDiff, Virtualizer } from "@pierre/diffs/react";
import type { PrHubChangedFile } from "@t3tools/contracts";
import { useAppSettings } from "../../appSettings";
import { useTheme } from "../../hooks/useTheme";
import {
  buildFileDiffRenderKey,
  DIFF_PANEL_UNSAFE_CSS,
  getRenderablePatch,
  resolveFileDiffPath,
} from "../../lib/diffPatch";
import { resolveDiffThemeName } from "../../lib/diffRendering";
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
  const displayPatch = useMemo(
    () =>
      file.patch && settings.diffIgnoreWhitespace ? substantivePrPatch(file.patch) : file.patch,
    [file.patch, settings.diffIgnoreWhitespace],
  );
  const patch = useMemo(
    () => getRenderablePatch(displayPatch ?? undefined, scope),
    [displayPatch, scope],
  );
  if (file.patchStatus === "available" && file.patch && displayPatch === null)
    return (
      <p className="p-3 text-sm text-muted-foreground">
        Only whitespace changes. Turn off whitespace filtering to inspect them.
      </p>
    );
  if (file.patchStatus !== "available" || !patch || patch.kind !== "files") {
    return (
      <p className="p-3 text-sm text-muted-foreground">
        {file.patchStatus === "truncated"
          ? "GitHub returned an incomplete patch."
          : "A renderable text patch is unavailable for this file."}{" "}
        <a href={url} target="_blank" rel="noreferrer" className="underline">
          Open on GitHub
        </a>
      </p>
    );
  }
  return (
    <DiffSurfaceBoundary fallback={<p className="p-3 text-sm">Loading diff…</p>}>
      <Virtualizer
        className="diff-render-surface h-[32rem] overflow-auto"
        config={{ overscrollSize: 600, intersectionObserverMargin: 1200 }}
      >
        {patch.files.map((diff) => (
          <div key={buildFileDiffRenderKey(diff)} data-diff-file-path={resolveFileDiffPath(diff)}>
            <FileDiff
              fileDiff={diff}
              options={{
                diffStyle: settings.diffRenderMode === "split" ? "split" : "unified",
                lineDiffType: "none",
                ...(onComment
                  ? {
                      onLineNumberClick: (event) => {
                        const anchor: PrReviewAnchor = {
                          path: file.path,
                          line: event.lineNumber,
                          side: event.annotationSide === "deletions" ? "LEFT" : "RIGHT",
                        };
                        if (file.patch && isPrReviewAnchorInPatch(anchor, file.patch))
                          onComment(anchor);
                      },
                    }
                  : {}),
                overflow: settings.diffWordWrap ? "wrap" : "scroll",
                theme: resolveDiffThemeName(resolvedTheme),
                themeType: resolvedTheme,
                unsafeCSS: DIFF_PANEL_UNSAFE_CSS,
              }}
            />
          </div>
        ))}
      </Virtualizer>
    </DiffSurfaceBoundary>
  );
}
