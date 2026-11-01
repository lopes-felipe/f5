import { type TurnId } from "@t3tools/contracts";
import {
  type ReactNode,
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { type TurnDiffFileChange } from "../../types";
import { buildTurnDiffTree, type TurnDiffTreeNode } from "../../lib/turnDiffTree";
import { ChevronRightIcon, FolderIcon, FolderClosedIcon } from "lucide-react";
import { cn } from "~/lib/utils";
import { DiffStatLabel, hasNonZeroStat } from "./DiffStatLabel";
import { VscodeEntryIcon } from "./VscodeEntryIcon";

/** Visible rows above which only the rows near the scroll viewport mount. */
export const CHANGED_FILES_VIRTUALIZE_AFTER_ROWS = 250;
const ROW_OVERSCAN = 8;
const INITIAL_RENDERED_ROWS = 40;

interface ChangedFileRow {
  node: TurnDiffTreeNode;
  depth: number;
}

export const ChangedFilesTree = memo(function ChangedFilesTree(props: {
  turnId: TurnId;
  files: ReadonlyArray<TurnDiffFileChange>;
  allDirectoriesExpanded: boolean;
  resolvedTheme: "light" | "dark";
  onOpenTurnDiff: (turnId: TurnId, filePath?: string) => void;
}) {
  const { files, allDirectoriesExpanded, onOpenTurnDiff, resolvedTheme, turnId } = props;
  const treeNodes = useMemo(() => buildTurnDiffTree(files), [files]);
  const directoryPathsKey = useMemo(
    () => collectDirectoryPaths(treeNodes).join("\u0000"),
    [treeNodes],
  );
  const allDirectoryExpansionState = useMemo(
    () =>
      buildDirectoryExpansionState(
        directoryPathsKey ? directoryPathsKey.split("\u0000") : [],
        allDirectoriesExpanded,
      ),
    [allDirectoriesExpanded, directoryPathsKey],
  );
  const [expandedDirectories, setExpandedDirectories] = useState<Record<string, boolean>>(() =>
    buildDirectoryExpansionState(directoryPathsKey ? directoryPathsKey.split("\u0000") : [], true),
  );
  useEffect(() => {
    setExpandedDirectories(allDirectoryExpansionState);
  }, [allDirectoryExpansionState]);

  const toggleDirectory = useCallback((pathValue: string, fallbackExpanded: boolean) => {
    setExpandedDirectories((current) => ({
      ...current,
      [pathValue]: !(current[pathValue] ?? fallbackExpanded),
    }));
  }, []);

  const rows = useMemo(
    () => collectExpandedRows(treeNodes, expandedDirectories),
    [expandedDirectories, treeNodes],
  );

  const renderRow = ({ node, depth }: ChangedFileRow) => {
    const leftPadding = 8 + depth * 14;
    if (node.kind === "directory") {
      const isExpanded = isDirectoryExpanded(expandedDirectories, node.path, depth);
      return (
        <button
          type="button"
          aria-expanded={isExpanded}
          className="group flex h-6 w-full items-center gap-1.5 rounded-md pr-2 text-left hover:bg-background/80"
          style={{ paddingLeft: `${leftPadding}px` }}
          onClick={() => toggleDirectory(node.path, depth === 0)}
        >
          <ChevronRightIcon
            aria-hidden="true"
            className={cn(
              "size-3.5 shrink-0 text-muted-foreground transition-transform group-hover:text-foreground",
              isExpanded && "rotate-90",
            )}
          />
          {isExpanded ? (
            <FolderIcon className="size-3.5 shrink-0 text-muted-foreground" />
          ) : (
            <FolderClosedIcon className="size-3.5 shrink-0 text-muted-foreground" />
          )}
          <span className="truncate font-mono text-2xs text-muted-foreground group-hover:text-foreground">
            {node.name}
          </span>
          {hasNonZeroStat(node.stat) && (
            <span className="ml-auto shrink-0 font-mono text-2xs tabular-nums">
              <DiffStatLabel additions={node.stat.additions} deletions={node.stat.deletions} />
            </span>
          )}
        </button>
      );
    }

    return (
      <button
        type="button"
        className="group flex h-6 w-full items-center gap-1.5 rounded-md pr-2 text-left hover:bg-background/80"
        style={{ paddingLeft: `${leftPadding}px` }}
        onClick={() => onOpenTurnDiff(turnId, node.path)}
      >
        <span aria-hidden="true" className="size-3.5 shrink-0" />
        <VscodeEntryIcon
          pathValue={node.path}
          kind="file"
          theme={resolvedTheme}
          className="size-3.5 text-muted-foreground"
        />
        <span className="truncate font-mono text-2xs text-muted-foreground group-hover:text-foreground">
          {node.name}
        </span>
        {node.stat && (
          <span className="ml-auto shrink-0 font-mono text-2xs tabular-nums">
            <DiffStatLabel additions={node.stat.additions} deletions={node.stat.deletions} />
          </span>
        )}
      </button>
    );
  };

  return (
    <ChangedFilesRows
      rows={rows}
      renderRow={renderRow}
      virtualized={rows.length > CHANGED_FILES_VIRTUALIZE_AFTER_ROWS}
    />
  );
});

function ChangedFilesRows({
  rows,
  renderRow,
  virtualized,
}: {
  rows: ReadonlyArray<ChangedFileRow>;
  renderRow: (row: ChangedFileRow) => ReactNode;
  virtualized: boolean;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const rowPitchRef = useRef<HTMLDivElement>(null);
  const [range, setRange] = useState({ start: 0, end: INITIAL_RENDERED_ROWS, rowPitch: 26 });
  const [focusedPath, setFocusedPath] = useState<string | null>(null);

  useLayoutEffect(() => {
    const container = containerRef.current;
    const rowPitch = rowPitchRef.current;
    if (!virtualized || !container || !rowPitch) return;

    // The card sits inside the timeline's scroller, so its own scrollTop stays zero. Watch
    // the ancestors up to that scroller too: streaming text above can move the card. Wrappers
    // between here and the timeline must clip with `overflow-x-clip`, not `hidden`, or the walk
    // stops at them (see MessagesTimeline).
    const resized: HTMLElement[] = [container, rowPitch];
    let scrollElement: HTMLElement | null = null;
    for (let parent = container.parentElement; parent; parent = parent.parentElement) {
      resized.push(parent);
      if (/auto|scroll/.test(getComputedStyle(parent).overflowY)) {
        scrollElement = parent;
        break;
      }
    }

    const measure = () => {
      const pitch = rowPitch.getBoundingClientRect().height;
      if (pitch <= 0) return;
      const listTop = container.getBoundingClientRect().top;
      const viewportTop = scrollElement
        ? scrollElement.getBoundingClientRect().top + scrollElement.clientTop
        : 0;
      const viewportHeight = scrollElement?.clientHeight ?? document.documentElement.clientHeight;
      const start = Math.max(
        0,
        Math.min(rows.length, Math.floor((viewportTop - listTop) / pitch) - ROW_OVERSCAN),
      );
      const end = Math.max(
        start,
        Math.min(
          rows.length,
          Math.ceil((viewportTop + viewportHeight - listTop) / pitch) + ROW_OVERSCAN,
        ),
      );
      setRange((current) =>
        current.start === start && current.end === end && current.rowPitch === pitch
          ? current
          : { start, end, rowPitch: pitch },
      );
    };
    measure();
    const scrollTarget = scrollElement ?? window;
    let frame = 0;
    const scheduleMeasure = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        measure();
      });
    };
    scrollTarget.addEventListener("scroll", scheduleMeasure, { passive: true });
    window.addEventListener("resize", scheduleMeasure);
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    for (const element of resized) observer?.observe(element);
    return () => {
      scrollTarget.removeEventListener("scroll", scheduleMeasure);
      window.removeEventListener("resize", scheduleMeasure);
      if (frame) cancelAnimationFrame(frame);
      observer?.disconnect();
    };
  }, [virtualized, rows.length]);

  if (!virtualized) {
    return (
      <div className="space-y-0.5">
        {rows.map((row) => (
          <div key={`${row.node.kind}:${row.node.path}`}>{renderRow(row)}</div>
        ))}
      </div>
    );
  }

  const focusedIndex =
    focusedPath === null ? -1 : rows.findIndex((row) => row.node.path === focusedPath);
  const start = Math.min(rows.length, range.start);
  const end = Math.min(rows.length, range.end);
  const indices = Array.from({ length: Math.max(0, end - start) }, (_, index) => start + index);
  // Keep keyboard focus on its row when scrolling moves it outside the rendered window.
  if (focusedIndex >= 0 && focusedIndex < start) indices.unshift(focusedIndex);
  if (focusedIndex >= end) indices.push(focusedIndex);
  return (
    <div
      ref={containerRef}
      className="relative"
      style={{ height: rows.length * range.rowPitch }}
      onFocusCapture={(event) => {
        const row = event.target.closest<HTMLElement>("[data-changed-file-row]");
        setFocusedPath(row?.dataset.changedFileRow ?? null);
      }}
      onBlurCapture={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setFocusedPath(null);
      }}
    >
      {/* One row plus the gap between rows, matching `h-6` rows in a `space-y-0.5` list. */}
      <div
        ref={rowPitchRef}
        aria-hidden="true"
        className="pointer-events-none invisible absolute h-6.5"
      />
      {indices.map((index) => {
        const row = rows[index]!;
        return (
          <div
            key={`${row.node.kind}:${row.node.path}`}
            data-changed-file-row={row.node.path}
            className="absolute inset-x-0"
            style={{ top: index * range.rowPitch }}
          >
            {renderRow(row)}
          </div>
        );
      })}
    </div>
  );
}

function isDirectoryExpanded(
  expandedDirectories: Readonly<Record<string, boolean>>,
  path: string,
  depth: number,
): boolean {
  return expandedDirectories[path] ?? depth === 0;
}

function collectExpandedRows(
  nodes: ReadonlyArray<TurnDiffTreeNode>,
  expandedDirectories: Readonly<Record<string, boolean>>,
  depth = 0,
  rows: ChangedFileRow[] = [],
): ChangedFileRow[] {
  for (const node of nodes) {
    rows.push({ node, depth });
    if (node.kind === "directory" && isDirectoryExpanded(expandedDirectories, node.path, depth)) {
      collectExpandedRows(node.children, expandedDirectories, depth + 1, rows);
    }
  }
  return rows;
}

function collectDirectoryPaths(nodes: ReadonlyArray<TurnDiffTreeNode>): string[] {
  const paths: string[] = [];
  for (const node of nodes) {
    if (node.kind !== "directory") continue;
    paths.push(node.path);
    paths.push(...collectDirectoryPaths(node.children));
  }
  return paths;
}

function buildDirectoryExpansionState(
  directoryPaths: ReadonlyArray<string>,
  expanded: boolean,
): Record<string, boolean> {
  const expandedState: Record<string, boolean> = {};
  for (const directoryPath of directoryPaths) {
    expandedState[directoryPath] = expanded;
  }
  return expandedState;
}
