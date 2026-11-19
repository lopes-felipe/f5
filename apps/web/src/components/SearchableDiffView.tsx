import { CodeView, type CodeViewHandle, type CodeViewProps } from "@pierre/diffs/react";
import type { CodeViewItem, FileDiffMetadata } from "@pierre/diffs";
import { useMemo, useRef, type Ref, type MouseEvent } from "react";
import { ChevronDownIcon, ChevronRightIcon } from "lucide-react";
import { resolveFileDiffPath } from "../lib/diffPatch";
import { summarizeFileDiffMetadataStats } from "../lib/diffPatch";
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
  const pathOf = (item: CodeViewItem<undefined>) =>
    item.type === "diff" ? resolveFileDiffPath(item.fileDiff) : item.file.name;
  return (
    <div data-find-scope="diff" className="contents">
      <CodeView
        {...(viewerRef ? { ref: viewerRef } : {})}
        className={className}
        items={items}
        {...(options ? { options } : {})}
        onRevealSearchMatch={(item) => onCollapse?.(item.id, false)}
        renderCustomHeader={(item) => (
          <div
            data-diff-file-path={pathOf(item)}
            className="flex items-center gap-2 border-b border-border bg-card px-2 py-2 text-xs"
            onContextMenu={(event) => onFileContextMenu?.(event, pathOf(item))}
          >
            {onCollapse ? (
              <button
                type="button"
                className="rounded-sm p-0.5 text-muted-foreground hover:text-foreground"
                aria-label={(item.collapsed ? "Expand " : "Collapse ") + pathOf(item)}
                aria-expanded={!item.collapsed}
                onClick={() => onCollapse(item.id, !item.collapsed)}
              >
                {item.collapsed ? (
                  <ChevronRightIcon className="size-3" />
                ) : (
                  <ChevronDownIcon className="size-3" />
                )}
              </button>
            ) : null}
            {onOpenFile ? (
              <button
                type="button"
                className="min-w-0 truncate text-left hover:underline"
                onClick={() => onOpenFile(pathOf(item))}
              >
                {pathOf(item)}
              </button>
            ) : (
              <span className="truncate">{pathOf(item)}</span>
            )}
            <span className="ml-auto flex shrink-0 items-center gap-2">
              {item.type === "diff" ? (
                <DiffStatLabel {...summarizeFileDiffMetadataStats([item.fileDiff])} />
              ) : null}
              <CopyPathButton path={pathOf(item)} />
            </span>
          </div>
        )}
      />
    </div>
  );
}
