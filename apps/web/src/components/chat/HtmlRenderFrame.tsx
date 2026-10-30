import { useServerKeybindings, resolveShortcutCommand } from "../../keybindings";
import { useAppSettingsSelector } from "../../appSettings";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { HTML_RENDER_MAX_PAGE_BYTES, type HtmlRenderReference } from "@t3tools/contracts";
import {
  HTML_RENDER_MAX_CONTENT_HEIGHT,
  HTML_RENDER_MAX_FIT_HEIGHT,
  htmlRenderDocument,
  initialHtmlRenderFit,
  nextHtmlRenderFit,
  readHtmlRenderMeasurement,
  type HtmlRenderFitState,
  type HtmlRenderMeasurement,
  type HtmlRenderTheme,
} from "@t3tools/shared/htmlRender";
import { attachmentPreviewUrlForId } from "../../orchestrationState";
import { useHtmlRenderTheme } from "../../hooks/useHtmlRenderTheme";
import { readBoundedResponseText } from "../../lib/readBoundedResponseText";
import { useOpenLink } from "../../hooks/useOpenLink";
import { Button } from "../ui/button";
import { Dialog, DialogPopup, DialogTitle } from "../ui/dialog";
import { Skeleton } from "../ui/skeleton";
import { buildExpandedImagePreview, type ExpandedImagePreview } from "./ExpandedImagePreview";
import { replayWheelOnTimeline } from "./timelineMinimapWheel";

type ShortcutKey = {
  readonly key: string;
  readonly code: string;
  readonly metaKey: boolean;
  readonly ctrlKey: boolean;
  readonly shiftKey: boolean;
  readonly altKey: boolean;
  readonly repeat: boolean;
};

/** The last measured inline height per page, so a remount under virtualization does not jump. */
const measuredHeights = new Map<string, number>();
const MEASURED_HEIGHTS_LIMIT = 200;
function rememberHeight(attachmentId: string, height: number) {
  measuredHeights.delete(attachmentId);
  measuredHeights.set(attachmentId, height);
  if (measuredHeights.size > MEASURED_HEIGHTS_LIMIT)
    measuredHeights.delete(measuredHeights.keys().next().value!);
}

function scrollableAncestor(element: HTMLElement | null | undefined): HTMLElement | null {
  while (element) {
    if (
      /(auto|scroll)/.test(getComputedStyle(element).overflowY) &&
      element.scrollHeight > element.clientHeight
    )
      return element;
    element = element.parentElement;
  }
  return null;
}

/**
 * One sandboxed document and its MessagePort bridge. Key it by document
 * identity: a new document gets a new bridge id and port, and the retired
 * bridge's late messages are ignored. Theme, shortcut and sizing updates go
 * over the port and never rebuild `srcDoc`, so page state survives them.
 */
function HtmlRenderDocumentFrame(props: {
  readonly html: string;
  readonly title: string;
  readonly attachmentId: string;
  readonly allowRemoteContent: boolean;
  readonly theme: HtmlRenderTheme;
  readonly sizingMode: "fit" | "scroll";
  readonly dialogFocus: boolean;
  readonly onMeasure: (measurement: HtmlRenderMeasurement) => void;
  readonly onEscape: () => void;
  readonly onShortcut: (key: ShortcutKey) => void;
  readonly onImageExpand: (preview: ExpandedImagePreview) => void;
  readonly style: CSSProperties;
}) {
  const bindings = useServerKeybindings();
  const openLink = useOpenLink();
  const [bridgeId, setBridgeId] = useState(() => crypto.randomUUID());
  const frame = useRef<HTMLIFrameElement>(null);
  const port = useRef<MessagePort | null>(null);
  const latest = useRef(props);
  latest.current = props;
  const shortcuts = useMemo(() => {
    const mac = /Mac|iPhone|iPad/.test(navigator.platform);
    return bindings.map(({ shortcut }) => ({
      ...shortcut,
      metaKey: shortcut.metaKey || (shortcut.modKey && mac),
      ctrlKey: shortcut.ctrlKey || (shortcut.modKey && !mac),
    }));
  }, [bindings]);
  const shortcutsRef = useRef(shortcuts);
  shortcutsRef.current = shortcuts;
  const receive = useRef<(event: MessageEvent) => void>(() => undefined);
  receive.current = (event: MessageEvent) => {
    const data = event.data;
    if (!data || data.f5HtmlRender !== bridgeId) return;
    const current = latest.current;
    if (data.type === "height") {
      const measurement = readHtmlRenderMeasurement(data.value);
      if (measurement) current.onMeasure(measurement);
    }
    if (data.type === "wheel") {
      const { x, y, mode } = (data.value ?? {}) as Record<string, unknown>;
      if (
        typeof x === "number" &&
        typeof y === "number" &&
        Number.isFinite(x) &&
        Number.isFinite(y) &&
        (mode === 0 || mode === 1 || mode === 2)
      ) {
        // A real wheel event on the timeline, so its listeners stop following the tail.
        const target = scrollableAncestor(frame.current?.parentElement);
        if (target) replayWheelOnTimeline({ x, y, mode }, target, { maxPixels: 1000 });
      }
    }
    if (data.type === "keydown") {
      const value = data.value;
      if (
        value &&
        typeof value.key === "string" &&
        value.key.length <= 32 &&
        typeof value.code === "string" &&
        value.code.length <= 32 &&
        [value.metaKey, value.ctrlKey, value.shiftKey, value.altKey, value.repeat].every(
          (entry) => typeof entry === "boolean",
        ) &&
        resolveShortcutCommand(value, bindings, {
          context: {
            terminalFocus: false,
            terminalOpen: false,
            dialogFocus: current.dialogFocus,
            composerFocus: false,
          },
        })
      )
        current.onShortcut(value);
    }
    if (data.type === "escape") current.onEscape();
    if (data.type === "link" && typeof data.value === "string" && data.value.length <= 8192) {
      try {
        // Same routing as chat links: pull requests and the preview pane included.
        void openLink(new URL(data.value).href).catch(() => undefined);
      } catch {
        /* Invalid page link. */
      }
    }
    if (data.type === "image" && typeof data.value?.src === "string") {
      const src: string = data.value.src;
      if (
        src.length > HTML_RENDER_MAX_PAGE_BYTES * 2 ||
        !/^(?:https:\/\/|data:image\/(?:png|jpeg|webp|gif|avif|svg\+xml);)/i.test(src)
      )
        return;
      const preview = buildExpandedImagePreview(
        [
          {
            id: current.attachmentId,
            name: String(data.value.name ?? "Rendered image").slice(0, 255),
            mimeType: /^data:([^;]+)/.exec(src)?.[1] ?? "image/png",
            previewUrl: src,
            sourceUrl: src,
          },
        ],
        current.attachmentId,
      );
      if (preview) current.onImageExpand(preview);
    }
  };
  useLayoutEffect(() => {
    port.current?.postMessage({ type: "shortcuts", value: shortcuts });
  }, [shortcuts]);
  useLayoutEffect(() => {
    port.current?.postMessage({ type: "theme", value: props.theme });
  }, [props.theme]);
  useLayoutEffect(() => {
    port.current?.postMessage({ type: "sizing", value: props.sizingMode });
  }, [props.sizingMode]);
  // Bootstraps with the theme current when the document is built, not when the frame mounted.
  const themeRef = useRef(props.theme);
  themeRef.current = props.theme;
  const document = useMemo(
    () =>
      htmlRenderDocument(props.html, themeRef.current, bridgeId, {
        allowRemoteContent: props.allowRemoteContent,
      }),
    [props.html, bridgeId, props.allowRemoteContent],
  );
  useLayoutEffect(() => {
    const connect = (event: MessageEvent) => {
      if (
        event.source !== frame.current?.contentWindow ||
        event.data?.f5HtmlRender !== bridgeId ||
        event.data?.type !== "connect" ||
        event.ports.length !== 1 ||
        port.current
      )
        return;
      const channel = event.ports[0]!;
      port.current = channel;
      channel.onmessage = (message) => receive.current(message);
      channel.postMessage({ type: "shortcuts", value: shortcutsRef.current });
      channel.postMessage({ type: "theme", value: latest.current.theme });
      channel.postMessage({ type: "sizing", value: latest.current.sizingMode });
    };
    window.addEventListener("message", connect);
    return () => {
      window.removeEventListener("message", connect);
      // The old document's port closes before the new one may connect.
      port.current?.close();
      port.current = null;
    };
  }, [bridgeId, document]);
  // Moving the iframe in the DOM, as list virtualization does when it recycles rows, reloads
  // it, and the reloaded page cannot take over the existing port. Rebuild it under a new
  // bridge id instead, so only the fresh document can connect.
  const expectingLoad = useRef(true);
  useLayoutEffect(() => {
    expectingLoad.current = true;
  }, [document]);
  const loaded = () => {
    if (expectingLoad.current) expectingLoad.current = false;
    else setBridgeId(crypto.randomUUID());
  };
  // The CSP limits what the page loads, not where it navigates. The desktop app blocks a srcdoc
  // frame from navigating anywhere else (appFramePolicy); a plain browser has no such hook, so
  // there a page can still leave with its contents in the URL.
  return (
    <iframe
      ref={frame}
      title={props.title}
      sandbox="allow-scripts"
      referrerPolicy="no-referrer"
      srcDoc={document}
      onLoad={loaded}
      className="block w-full border-0"
      style={props.style}
    />
  );
}

export function HtmlRenderFrame({
  reference,
  onImageExpand,
}: {
  reference: HtmlRenderReference;
  onImageExpand: (preview: ExpandedImagePreview) => void;
}) {
  const theme = useHtmlRenderTheme();
  const host = useRef<HTMLDivElement>(null);
  const [html, setHtml] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [visible, setVisible] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [zoom, setZoom] = useState(1);
  // Follows the chat's remote-image setting, so a page cannot reach the network on its own.
  const allowRemoteContent = useAppSettingsSelector((settings) => settings.loadRemoteImagesInChat);
  const documentKey = `${reference.attachmentId}:${attempt}:${allowRemoteContent}`;
  const startHeight = () => measuredHeights.get(reference.attachmentId) ?? reference.height;
  const [fit, setFitState] = useState(() => initialHtmlRenderFit(startHeight()));
  const fitRef = useRef(fit);
  const setFit = useCallback((next: HtmlRenderFitState) => {
    fitRef.current = next;
    setFitState(next);
  }, []);
  const contentHeight = useRef<number | null>(null);
  const [fullFit, setFullFitState] = useState(() =>
    initialHtmlRenderFit(fit.height, HTML_RENDER_MAX_CONTENT_HEIGHT),
  );
  const fullFitRef = useRef(fullFit);
  // A replaced document starts sizing over, and its loop guard with it.
  const previousKey = useRef(documentKey);
  useLayoutEffect(() => {
    if (previousKey.current === documentKey) return;
    previousKey.current = documentKey;
    contentHeight.current = null;
    setFit(initialHtmlRenderFit(startHeight()));
  }, [documentKey, setFit]);
  useEffect(() => {
    const element = host.current;
    if (!element) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setVisible(true);
          observer.disconnect();
        }
      },
      { rootMargin: "200px" },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (!visible) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
      setFailed(true);
    }, 15_000);
    setFailed(false);
    setHtml(null);
    void fetch(attachmentPreviewUrlForId(reference.attachmentId), {
      credentials: "include",
      signal: controller.signal,
    })
      .then((response) => readBoundedResponseText(response, HTML_RENDER_MAX_PAGE_BYTES))
      .then((value) => {
        if (!controller.signal.aborted) setHtml(value);
      })
      .catch(() => {
        if (!controller.signal.aborted) setFailed(true);
      })
      .finally(() => clearTimeout(timer));
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [visible, reference.attachmentId, attempt]);
  const measureInline = useCallback(
    (measurement: HtmlRenderMeasurement) => {
      contentHeight.current = Math.min(
        HTML_RENDER_MAX_CONTENT_HEIGHT,
        Math.ceil(measurement.height),
      );
      const next = nextHtmlRenderFit(fitRef.current, measurement);
      if (next === fitRef.current) return;
      setFit(next);
      if (next.mode !== "paused") rememberHeight(reference.attachmentId, next.height);
    },
    [reference.attachmentId, setFit],
  );
  const measureFullscreen = useCallback((measurement: HtmlRenderMeasurement) => {
    const next = nextHtmlRenderFit(fullFitRef.current, measurement, HTML_RENDER_MAX_CONTENT_HEIGHT);
    fullFitRef.current = next;
    setFullFitState(next);
  }, []);
  const openFullscreen = () => {
    const next = initialHtmlRenderFit(
      contentHeight.current ?? fitRef.current.height,
      HTML_RENDER_MAX_CONTENT_HEIGHT,
    );
    fullFitRef.current = next;
    setFullFitState(next);
    setFullscreen(true);
  };
  const escape = useCallback(() => {
    setFullscreen(false);
    host.current?.focus();
  }, []);
  const shortcut = useCallback((value: ShortcutKey) => {
    host.current?.focus();
    host.current?.dispatchEvent(
      new KeyboardEvent("keydown", { ...value, bubbles: true, cancelable: true }),
    );
  }, []);
  const frameProps = {
    html: html ?? "",
    title: reference.title,
    attachmentId: reference.attachmentId,
    allowRemoteContent,
    theme,
    onEscape: escape,
    onShortcut: shortcut,
    onImageExpand,
  };
  return (
    <div
      ref={host}
      tabIndex={-1}
      className="min-w-0 rounded border border-border bg-card"
      aria-label={`HTML render: ${reference.title}`}
    >
      <div className="flex items-center justify-between gap-2 border-b border-border p-2">
        <span className="truncate text-sm">{reference.title}</span>
        <Button size="xs" disabled={html === null} onClick={openFullscreen}>
          Fullscreen
        </Button>
      </div>
      {failed ? (
        <p role="alert" className="p-3 text-sm">
          Could not load this page.{" "}
          <Button size="xs" onClick={() => setAttempt(attempt + 1)}>
            Retry
          </Button>
        </p>
      ) : html === null ? (
        // Holds the page's own height, so the thread does not jump when it loads.
        <Skeleton
          role="status"
          aria-label="Loading page…"
          className="m-2 rounded-lg"
          style={{ height: `${Math.max(0, fit.height - 16)}px` }}
        />
      ) : (
        // Stays mounted while full screen is open, so the page keeps its state.
        <HtmlRenderDocumentFrame
          key={documentKey}
          {...frameProps}
          sizingMode={fit.mode === "fit" ? "fit" : "scroll"}
          dialogFocus={false}
          onMeasure={measureInline}
          style={{ height: `${fit.height}px` }}
        />
      )}
      {html !== null && fit.mode === "paused" ? (
        <p role="status" className="flex items-center gap-2 p-2 text-muted-foreground text-xs">
          Automatic sizing paused: this page grows with its frame.
          <Button
            size="xs"
            variant="outline"
            onClick={() => setFit(initialHtmlRenderFit(fit.height))}
          >
            Retry sizing
          </Button>
        </p>
      ) : html !== null && fit.mode === "capped" ? (
        <p className="p-2 text-muted-foreground text-xs">
          This page is taller than {HTML_RENDER_MAX_FIT_HEIGHT.toLocaleString()}px; scroll inside it
          or open it full screen.
        </p>
      ) : null}
      <Dialog open={fullscreen} onOpenChange={setFullscreen}>
        <DialogPopup className="h-[90dvh] max-w-[95vw] p-4" bottomStickOnMobile={false}>
          <DialogTitle>{reference.title}</DialogTitle>
          <div className="flex gap-2 py-2">
            <Button
              size="xs"
              disabled={zoom <= 0.5}
              onClick={() => setZoom(Math.max(0.5, zoom - 0.1))}
            >
              Zoom out
            </Button>
            <span className="text-sm">{Math.round(zoom * 100)}%</span>
            <Button size="xs" disabled={zoom >= 2} onClick={() => setZoom(Math.min(2, zoom + 0.1))}>
              Zoom in
            </Button>
          </div>
          <div className="min-h-0 flex-1 overflow-auto">
            {fullscreen && html !== null ? (
              // Its own copy of the page; the inline one keeps its state underneath.
              <HtmlRenderDocumentFrame
                key={`${documentKey}:fullscreen`}
                {...frameProps}
                sizingMode={fullFit.mode === "fit" ? "fit" : "scroll"}
                dialogFocus
                onMeasure={measureFullscreen}
                style={{ height: `${fullFit.height}px`, zoom }}
              />
            ) : null}
          </div>
        </DialogPopup>
      </Dialog>
    </div>
  );
}
