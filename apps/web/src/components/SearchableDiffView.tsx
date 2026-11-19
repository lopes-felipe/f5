import { CodeView, type CodeViewHandle, type CodeViewProps } from "@pierre/diffs/react";
import type { FileDiffMetadata } from "@pierre/diffs";
import { useMemo, useRef, type Ref, type MouseEvent } from "react";
import { ChevronDownIcon, ChevronRightIcon } from "lucide-react";
import {
  resolveFileDiffPath,
  resolvePreviousFileDiffPath,
  summarizeFileDiffMetadataStats,
} from "../lib/diffPatch";
import { DiffStatLabel } from "./chat/DiffStatLabel";
import { CopyPathButton } from "./CopyPathButton";

export interface SearchableDiffFile {
  id: string;
  fileDiff: FileDiffMetadata;
  collapsed: boolean;
}

/** CodeView owns search across virtualized rows; the host owns file folding. */
export function SearchableDiffView({
  files,
  options,
  onCollapse,
  onOpenFile,
  onFileContextMenu,
  viewerRef,
  className,
}: {
  files: ReadonlyArray<SearchableDiffFile>;
  options: CodeViewProps<undefined, undefined>["options"];
  onCollapse?: ((id: string, collapsed: boolean) => void) | undefined;
  onOpenFile?: ((path: string) => void) | undefined;
  onFileContextMenu?: ((event: MouseEvent, path: string) => void) | undefined;
  viewerRef?: Ref<CodeViewHandle<undefined, undefined>> | undefined;
  className: string;
}) {
  const revision = useRef(0);
  const identities = useRef(new WeakMap<FileDiffMetadata, number>());
  const items = useMemo(() => {
    return files.map((file) => {
      let identity = identities.current.get(file.fileDiff);
      if (identity === undefined) {
        identity = ++revision.current;
        identities.current.set(file.fileDiff, identity);
      }
      return { ...file, version: identity * 2 + Number(file.collapsed), type: "diff" as const };
    });
  }, [files]);
  return (
    <div data-find-scope="diff" className="contents">
      <CodeView
        {...(viewerRef ? { ref: viewerRef } : {})}
        className={className}
        items={items}
        {...(options ? { options } : {})}
        onRevealSearchMatch={(item) => onCollapse?.(item.id, false)}
        renderCustomHeader={(item) => {
          const filePath =
            item.type === "diff" ? resolveFileDiffPath(item.fileDiff) : item.file.name;
          const previous =
            item.type === "diff" ? resolvePreviousFileDiffPath(item.fileDiff) : undefined;
          const label = previous ? `${previous} → ${filePath}` : filePath;
          return (
            <div
              data-diff-file-path={filePath}
              className="relative flex items-center gap-2 border-b border-border bg-card px-2 py-2 text-xs"
              onContextMenu={(event) => onFileContextMenu?.(event, filePath)}
            >
              {onCollapse ? (
                <>
                  <button
                    type="button"
                    className="absolute inset-0 cursor-pointer rounded-sm hover:bg-muted/50 focus-visible:outline-1 focus-visible:-outline-offset-2 focus-visible:outline-ring"
                    aria-label={(item.collapsed ? "Expand " : "Collapse ") + filePath}
                    aria-expanded={!item.collapsed}
                    onClick={() => onCollapse(item.id, !item.collapsed)}
                  />
                  {item.collapsed ? (
                    <ChevronRightIcon className="pointer-events-none relative size-3 shrink-0 text-muted-foreground" />
                  ) : (
                    <ChevronDownIcon className="pointer-events-none relative size-3 shrink-0 text-muted-foreground" />
                  )}
                </>
              ) : null}
              {onOpenFile ? (
                <button
                  type="button"
                  title={label}
                  className="relative min-w-0 truncate text-left hover:underline"
                  onClick={() => onOpenFile(filePath)}
                >
                  {label}
                </button>
              ) : (
                <span className="pointer-events-none relative truncate" title={label}>
                  {label}
                </span>
              )}
              <span className="pointer-events-none relative ml-auto flex shrink-0 items-center gap-2">
                {item.type === "diff" ? (
                  <DiffStatLabel {...summarizeFileDiffMetadataStats([item.fileDiff])} />
                ) : null}
                <span className="pointer-events-auto">
                  <CopyPathButton path={filePath} />
                </span>
              </span>
            </div>
          );
        }}
      />
    </div>
  );
}
