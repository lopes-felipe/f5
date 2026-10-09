import type { ThreadId } from "@t3tools/contracts";
import {
  Suspense,
  createContext,
  lazy,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

import { ensureNativeApi } from "../nativeApi";
import { useRightPanelStore } from "../rightPanelStore";
import { DiffPanelLoadingState } from "./DiffPanelShell";
import {
  clearPreviewProjection,
  ensureHeadlessPreviewEntry,
  PINNED_PREVIEW_IDLE_MS,
  projectPreviewEntry,
  unpinPreviewEntry,
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

function PersistentPreviewInstance({
  entry,
  onUnpin,
}: {
  entry: PreviewProjectionEntry;
  onUnpin: (threadId: ThreadId) => void;
}) {
  const bounds = useProjectionBounds(entry.target);
  const projected = entry.visible && entry.target !== null;
  const { onClose: closeEntry, threadId, pinned } = entry;
  // Closing the preview is the user's explicit release of an agent-pinned slot.
  const onClose = useMemo(
    () =>
      pinned
        ? () => {
            onUnpin(threadId);
            closeEntry();
          }
        : closeEntry,
    [closeEntry, onUnpin, pinned, threadId],
  );

  return (
    <div
      aria-hidden={!projected}
      inert={!projected}
      className="fixed flex min-h-0 flex-col overflow-hidden bg-background"
      // A hidden instance stays inside the viewport, transparent and behind the app:
      // Chromium produces no frames for an off-screen guest, so agent screenshots would hang.
      style={{
        left: projected ? bounds.left : 0,
        top: projected ? bounds.top : 0,
        width: bounds.width,
        height: bounds.height,
        zIndex: projected ? 50 : -1,
        opacity: projected ? 1 : 0,
        pointerEvents: projected ? "auto" : "none",
      }}
    >
      <Suspense fallback={<DiffPanelLoadingState label="Loading preview..." />}>
        <PreviewPanel threadId={entry.threadId} visible={projected} onClose={onClose} />
      </Suspense>
    </div>
  );
}

const SEEN_OWNER_REQUEST_LIMIT = 200;

export function PreviewBrowserHost(props: { readonly children: ReactNode }) {
  const [entries, setEntries] = useState<ReadonlyMap<ThreadId, PreviewProjectionEntry>>(
    () => new Map(),
  );
  const entriesRef = useRef(entries);
  entriesRef.current = entries;
  const pinnedActivityRef = useRef(new Map<ThreadId, number>());

  const project = useCallback((entry: PreviewProjectionEntry) => {
    setEntries((current) => projectPreviewEntry(current, entry));
  }, []);

  const unpin = useCallback((threadId: ThreadId) => {
    pinnedActivityRef.current.delete(threadId);
    setEntries((current) => unpinPreviewEntry(current, threadId));
  }, []);

  // The server asks this window to host automation for a thread whose preview is not open.
  useEffect(() => {
    if (!window.desktopBridge?.preview?.automation) return;
    const api = ensureNativeApi();
    const seenRequestIds = new Set<string>();
    const unsubscribeRequested = api.preview.automation.onOwnerRequested((request) => {
      if (seenRequestIds.has(request.requestId)) return;
      seenRequestIds.add(request.requestId);
      if (seenRequestIds.size > SEEN_OWNER_REQUEST_LIMIT) {
        seenRequestIds.delete(seenRequestIds.values().next().value!);
      }
      const result = ensureHeadlessPreviewEntry(entriesRef.current, request.threadId, () =>
        unpin(request.threadId),
      );
      if (!result.ok) {
        void api.preview.automation
          .respond({
            requestId: request.requestId,
            ok: false,
            error: {
              _tag: "PreviewAutomationCapacityExceededError",
              message:
                "Every agent browser slot is in use by other threads. Close one of their previews or wait for those agents to finish.",
            },
          })
          .catch(() => undefined);
        return;
      }
      pinnedActivityRef.current.set(request.threadId, Date.now());
      entriesRef.current = result.entries;
      setEntries(result.entries);
      // Show the tab without opening the panel or stealing focus.
      useRightPanelStore.getState().addSurface(request.threadId, "preview");
    });
    const unsubscribeReleased = api.preview.automation.onOwnerReleased((event) =>
      unpin(event.threadId),
    );
    // Any agent action keeps its pinned preview alive.
    const unsubscribeActivity = api.preview.automation.onRequest((request) => {
      if (pinnedActivityRef.current.has(request.threadId)) {
        pinnedActivityRef.current.set(request.threadId, Date.now());
      }
    });
    const idleTimer = window.setInterval(() => {
      const now = Date.now();
      for (const [threadId, lastActivity] of pinnedActivityRef.current) {
        if (now - lastActivity >= PINNED_PREVIEW_IDLE_MS) unpin(threadId);
      }
    }, 60_000);
    return () => {
      unsubscribeRequested();
      unsubscribeReleased();
      unsubscribeActivity();
      window.clearInterval(idleTimer);
    };
  }, [unpin]);

  const clearProjection = useCallback((threadId: ThreadId, target: HTMLDivElement) => {
    setEntries((current) => clearPreviewProjection(current, threadId, target));
  }, []);

  const context = useMemo(() => ({ project, clearProjection }), [clearProjection, project]);

  return (
    <PreviewBrowserHostContext.Provider value={context}>
      {props.children}
      {[...entries.values()].map((entry) => (
        <PersistentPreviewInstance key={entry.threadId} entry={entry} onUnpin={unpin} />
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
