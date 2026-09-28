import { ChevronDownIcon, ChevronRightIcon, CopyIcon, FileIcon, FolderIcon } from "lucide-react";
import { useMemo, useState, type MouseEvent } from "react";
import { useAppSettings } from "../appSettings";
import { useCopyToClipboard } from "../hooks/useCopyToClipboard";
import { Button } from "./ui/button";

export interface ChangedFileTreeEntry {
  path: string;
  previousPath?: string | null | undefined;
}
interface Node {
  path: string;
  file?: ChangedFileTreeEntry;
  children: Map<string, Node>;
}
export function changedFileTreeRows(
  files: readonly ChangedFileTreeEntry[],
  collapsed: ReadonlySet<string>,
  flat: boolean,
) {
  const root: Node = { path: "", children: new Map() };
  for (const file of files) {
    let node = root;
    const parts = flat ? [file.path] : file.path.split("/");
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i]!;
      let child = node.children.get(part);
      if (!child) {
        child = { path: flat ? part : parts.slice(0, i + 1).join("/"), children: new Map() };
        node.children.set(part, child);
      }
      node = child;
    }
    node.file = file;
  }
  const rows: { path: string; depth: number; file?: ChangedFileTreeEntry }[] = [];
  const visit = (node: Node, depth: number) => {
    for (const child of [...node.children.values()].sort(
      (a, b) =>
        Number(Boolean(a.file)) - Number(Boolean(b.file)) ||
        a.path.localeCompare(b.path, undefined, { numeric: true }),
    )) {
      rows.push({ path: child.path, depth, ...(child.file ? { file: child.file } : {}) });
      if (!collapsed.has(child.path)) visit(child, depth + 1);
    }
  };
  visit(root, 0);
  return rows;
}

/** Shared navigation and folder preferences for chat and pull-request diffs. */
export function ChangedFileTree({
  files,
  scope,
  onSelect,
  onContextMenu,
}: {
  files: readonly ChangedFileTreeEntry[];
  scope: string;
  onSelect: (path: string) => void;
  onContextMenu?: (event: MouseEvent, path: string) => void;
}) {
  const { settings, updateSettings } = useAppSettings();
  const { copyToClipboard } = useCopyToClipboard();
  const [visibleCount, setVisibleCount] = useState(250);
  const collapsed = useMemo(
    () => new Set(settings.diffCollapsedFolders[scope] ?? []),
    [scope, settings.diffCollapsedFolders],
  );
  const rows = useMemo(
    () => changedFileTreeRows(files, collapsed, settings.diffFileTreeOrder === "path"),
    [files, collapsed, settings.diffFileTreeOrder],
  );
  const setCollapsed = (paths: readonly string[]) => {
    // Bound per-workspace preferences without coupling their lifetime to a render.
    const previous = Object.entries(settings.diffCollapsedFolders)
      .filter(([key]) => key !== scope)
      .slice(-49);
    updateSettings({
      diffCollapsedFolders: Object.fromEntries([...previous, [scope, [...paths]]]),
    });
  };
  return (
    <details className="shrink-0 border-b border-border text-xs">
      <summary className="cursor-pointer px-3 py-2">Changed files ({files.length})</summary>
      <div className="flex flex-wrap gap-2 px-2 pb-2">
        <Button
          size="xs"
          variant="ghost"
          onClick={() =>
            updateSettings({
              diffFileTreeOrder: settings.diffFileTreeOrder === "path" ? "folders" : "path",
            })
          }
        >
          {settings.diffFileTreeOrder === "path" ? "Show folders" : "Sort by full path"}
        </Button>
        <Button size="xs" variant="ghost" onClick={() => setCollapsed([])}>
          Expand folders
        </Button>
        <Button
          size="xs"
          variant="ghost"
          onClick={() =>
            setCollapsed(
              changedFileTreeRows(files, new Set(), false)
                .filter((row) => !row.file)
                .map((row) => row.path),
            )
          }
        >
          Collapse folders
        </Button>
      </div>
      <div className="max-h-64 overflow-auto px-2 pb-2" aria-label="Changed file navigation">
        {rows.slice(0, visibleCount).map((row) => (
          <div
            key={row.path}
            className="group flex min-w-0 items-center gap-1"
            style={{ paddingLeft: row.depth * 12 }}
          >
            <button
              type="button"
              className="flex min-w-0 flex-1 items-center gap-1 rounded px-1 py-1 text-left hover:bg-accent"
              title={row.file?.previousPath ? `${row.file.previousPath} → ${row.path}` : row.path}
              aria-expanded={row.file ? undefined : !collapsed.has(row.path)}
              onContextMenu={
                row.file && onContextMenu ? (event) => onContextMenu(event, row.path) : undefined
              }
              onClick={() => {
                if (row.file) onSelect(row.path);
                else
                  setCollapsed(
                    collapsed.has(row.path)
                      ? [...collapsed].filter((path) => path !== row.path)
                      : [...collapsed, row.path],
                  );
              }}
            >
              {row.file ? (
                <FileIcon className="size-3 shrink-0" />
              ) : (
                <>
                  {collapsed.has(row.path) ? (
                    <ChevronRightIcon className="size-3 shrink-0" />
                  ) : (
                    <ChevronDownIcon className="size-3 shrink-0" />
                  )}
                  <FolderIcon className="size-3 shrink-0" />
                </>
              )}
              <span className="truncate">
                {settings.diffFileTreeOrder === "path" ? row.path : row.path.split("/").at(-1)}
              </span>
            </button>
            {row.file ? (
              <Button
                size="icon-xs"
                variant="ghost"
                aria-label={`Copy path ${row.path}`}
                onClick={() => copyToClipboard(row.path, undefined)}
              >
                <CopyIcon />
              </Button>
            ) : null}
          </div>
        ))}
        {rows.length > visibleCount ? (
          <Button
            size="xs"
            variant="outline"
            onClick={() => setVisibleCount((count) => count + 250)}
          >
            Show more ({rows.length - visibleCount} remaining)
          </Button>
        ) : null}
      </div>
    </details>
  );
}
