import type { ThreadId } from "@t3tools/contracts";
import {
  Suspense,
  createContext,
  lazy,
  useCallback,
  useContext,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

import { DiffPanelLoadingState } from "./DiffPanelShell";
import {
  clearPreviewProjection,
  projectPreviewEntry,
  type PreviewProjectionEntry,
} from "./PreviewBrowserHost.logic";

const PreviewPanel = lazy(() => import("./PreviewPanel"));

interface PreviewBrowserHostContextValue {
  readonly project: (entry: PreviewProjectionEntry) => void;
  readonly clearProjection: (threadId: ThreadId, target: HTMLDivElement) => void;
}

const PreviewBrowserHostContext = createContext<PreviewBrowserHostContextValue | null>(null);
const DEFAULT_HIDDEN_WIDTH = 1280;
const DEFAULT_HIDDEN_HEIGHT = 720;

function useProjectionBounds(target: HTMLDivElement | null) {
  const [bounds, setBounds] = useState({
    left: -100_000,
    top: 0,
    width: DEFAULT_HIDDEN_WIDTH,
    height: DEFAULT_HIDDEN_HEIGHT,
  });

  useLayoutEffect(() => {
    if (!target) return;
    let frame: number | null = null;
    const update = () => {
      frame = null;
      const next = target.getBoundingClientRect();
      if (next.width <= 1 || next.height <= 1) return;
      setBounds((current) => {
        const rounded = {
          left: Math.round(next.left),
          top: Math.round(next.top),
          width: Math.round(next.width),
          height: Math.round(next.height),
        };
        return current.left === rounded.left &&
          current.top === rounded.top &&
          current.width === rounded.width &&
          current.height === rounded.height
          ? current
          : rounded;
      });
    };
    const schedule = () => {
      if (frame !== null) return;
      frame = window.requestAnimationFrame(update);
    };
    schedule();
    const observer = new ResizeObserver(schedule);
    observer.observe(target);
    window.addEventListener("resize", schedule);
    window.addEventListener("scroll", schedule, true);
    return () => {
      if (frame !== null) window.cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener("resize", schedule);
      window.removeEventListener("scroll", schedule, true);
    };
  }, [target]);

  return bounds;
}

function PersistentPreviewInstance({ entry }: { entry: PreviewProjectionEntry }) {
  const bounds = useProjectionBounds(entry.target);
  const projected = entry.visible && entry.target !== null;

  return (
    <div
      aria-hidden={!projected}
      inert={!projected}
      className="fixed z-50 flex min-h-0 flex-col overflow-hidden bg-background"
      style={{
        left: projected ? bounds.left : -100_000,
        top: projected ? bounds.top : 0,
        width: bounds.width,
        height: bounds.height,
        opacity: projected ? 1 : 0,
        pointerEvents: projected ? "auto" : "none",
      }}
    >
      <Suspense fallback={<DiffPanelLoadingState label="Loading preview..." />}>
        <PreviewPanel threadId={entry.threadId} visible={projected} onClose={entry.onClose} />
      </Suspense>
    </div>
  );
}

export function PreviewBrowserHost(props: { readonly children: ReactNode }) {
  const [entries, setEntries] = useState<ReadonlyMap<ThreadId, PreviewProjectionEntry>>(
    () => new Map(),
  );

  const project = useCallback((entry: PreviewProjectionEntry) => {
    setEntries((current) => projectPreviewEntry(current, entry));
  }, []);

  const clearProjection = useCallback((threadId: ThreadId, target: HTMLDivElement) => {
    setEntries((current) => clearPreviewProjection(current, threadId, target));
  }, []);

  const context = useMemo(() => ({ project, clearProjection }), [clearProjection, project]);

  return (
    <PreviewBrowserHostContext.Provider value={context}>
      {props.children}
      {[...entries.values()].map((entry) => (
        <PersistentPreviewInstance key={entry.threadId} entry={entry} />
      ))}
    </PreviewBrowserHostContext.Provider>
  );
}

export function PreviewPanelProjection(props: {
  readonly threadId: ThreadId;
  readonly visible: boolean;
  readonly onClose: () => void;
}) {
  const host = useContext(PreviewBrowserHostContext);
  const [target, setTarget] = useState<HTMLDivElement | null>(null);
  const targetRef = useRef<HTMLDivElement | null>(null);
  if (!host) throw new Error("PreviewPanelProjection must be rendered inside PreviewBrowserHost.");

  useLayoutEffect(() => {
    if (!target) return;
    targetRef.current = target;
    host.project({
      threadId: props.threadId,
      target,
      visible: props.visible,
      onClose: props.onClose,
    });
  }, [host, props.onClose, props.threadId, props.visible, target]);

  useLayoutEffect(
    () => () => {
      const currentTarget = targetRef.current;
      if (currentTarget) host.clearProjection(props.threadId, currentTarget);
    },
    [host, props.threadId],
  );

  return <div ref={setTarget} className="flex min-h-0 flex-1" />;
}
