import { useServerKeybindings, resolveShortcutCommand } from "../../keybindings";
import { useAppSettingsSelector } from "../../appSettings";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { HTML_RENDER_MAX_PAGE_BYTES, type HtmlRenderReference } from "@t3tools/contracts";
import { htmlRenderDocument } from "@t3tools/shared/htmlRender";
import { attachmentPreviewUrlForId } from "../../orchestrationState";
import { useHtmlRenderTheme } from "../../hooks/useHtmlRenderTheme";
import { readBoundedResponseText } from "../../lib/readBoundedResponseText";
import { useOpenLink } from "../../hooks/useOpenLink";
import { Button } from "../ui/button";
import { Dialog, DialogPopup, DialogTitle } from "../ui/dialog";
import { Skeleton } from "../ui/skeleton";
import { buildExpandedImagePreview, type ExpandedImagePreview } from "./ExpandedImagePreview";

export function HtmlRenderFrame({
  reference,
  onImageExpand,
}: {
  reference: HtmlRenderReference;
  onImageExpand: (preview: ExpandedImagePreview) => void;
}) {
  const theme = useHtmlRenderTheme();
  const bindings = useServerKeybindings();
  const openLink = useOpenLink();
  const initialTheme = useRef(theme);
  const port = useRef<MessagePort | null>(null);
  const receiveRef = useRef<(event: MessageEvent) => void>(() => undefined);
  const optionsRef = useRef<unknown>(null);
  const host = useRef<HTMLDivElement>(null);
  const frame = useRef<HTMLIFrameElement>(null);
  const setFrame = useCallback((element: HTMLIFrameElement | null) => {
    if (frame.current !== element) {
      port.current?.close();
      port.current = null;
      frame.current = element;
    }
  }, []);
  const [bridgeId] = useState(() => crypto.randomUUID());
  const [html, setHtml] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [visible, setVisible] = useState(false);
  const [height, setHeight] = useState(reference.height);
  const [contentHeight, setContentHeight] = useState(reference.height);
  const [fullscreen, setFullscreen] = useState(false);
  const [zoom, setZoom] = useState(1);
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
  useLayoutEffect(() => {
    const receive = (event: MessageEvent) => {
      const data = event.data;
      if (!data || data.f5HtmlRender !== bridgeId) return;
      if (data.type === "height" && typeof data.value === "number" && Number.isFinite(data.value)) {
        setContentHeight(Math.max(120, Math.min(100_000, Math.ceil(data.value))));
        setHeight(Math.max(120, Math.min(2000, Math.ceil(data.value))));
      }
      if (
        data.type === "wheel" &&
        typeof data.value?.x === "number" &&
        typeof data.value?.y === "number" &&
        Number.isFinite(data.value.x) &&
        Number.isFinite(data.value.y)
      ) {
        let element = frame.current?.parentElement;
        while (element) {
          if (
            /(auto|scroll)/.test(getComputedStyle(element).overflowY) &&
            element.scrollHeight > element.clientHeight
          ) {
            element.scrollBy({
              left: Math.max(-1000, Math.min(1000, data.value.x)),
              top: Math.max(-1000, Math.min(1000, data.value.y)),
            });
            break;
          }
          element = element.parentElement;
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
              dialogFocus: fullscreen,
              composerFocus: false,
            },
          })
        ) {
          host.current?.focus();
          host.current?.dispatchEvent(
            new KeyboardEvent("keydown", { ...value, bubbles: true, cancelable: true }),
          );
        }
      }
      if (data.type === "escape") {
        setFullscreen(false);
        host.current?.focus();
      }
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
              id: reference.attachmentId,
              name: String(data.value.name ?? "Rendered image").slice(0, 255),
              mimeType: /^data:([^;]+)/.exec(src)?.[1] ?? "image/png",
              previewUrl: src,
              sourceUrl: src,
            },
          ],
          reference.attachmentId,
        );
        if (preview) onImageExpand(preview);
      }
    };
    receiveRef.current = receive;
    const mac = /Mac|iPhone|iPad/.test(navigator.platform);
    const shortcuts = bindings.map(({ shortcut }) => ({
      ...shortcut,
      metaKey: shortcut.metaKey || (shortcut.modKey && mac),
      ctrlKey: shortcut.ctrlKey || (shortcut.modKey && !mac),
    }));
    optionsRef.current = { shortcuts, theme };
    port.current?.postMessage({ type: "shortcuts", value: shortcuts });
    port.current?.postMessage({ type: "theme", value: theme });
  }, [bridgeId, onImageExpand, openLink, reference.attachmentId, bindings, fullscreen, theme]);
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
      channel.onmessage = (message) => receiveRef.current(message);
      const options = optionsRef.current as { shortcuts: unknown; theme: unknown };
      channel.postMessage({ type: "shortcuts", value: options.shortcuts });
      channel.postMessage({ type: "theme", value: options.theme });
    };
    window.addEventListener("message", connect);
    return () => {
      window.removeEventListener("message", connect);
      port.current?.close();
      port.current = null;
    };
  }, [bridgeId]);
  // Follows the chat's remote-image setting, so a page cannot reach the network on its own.
  const allowRemoteContent = useAppSettingsSelector((settings) => settings.loadRemoteImagesInChat);
  const document = useMemo(
    () =>
      html === null
        ? undefined
        : htmlRenderDocument(html, initialTheme.current, bridgeId, { allowRemoteContent }),
    [html, bridgeId, allowRemoteContent],
  );
  // The CSP limits what the page loads, not where it navigates. The desktop app blocks a srcdoc
  // frame from navigating anywhere else (appFramePolicy); a plain browser has no such hook, so
  // there a page can still leave with its contents in the URL.
  const iframe = document ? (
    <iframe
      ref={setFrame}
      title={reference.title}
      sandbox="allow-scripts"
      referrerPolicy="no-referrer"
      srcDoc={document}
      className="w-full border-0"
      style={{
        height: fullscreen ? `${contentHeight}px` : `${height}px`,
        zoom: fullscreen ? zoom : 1,
      }}
    />
  ) : null;
  return (
    <div
      ref={host}
      tabIndex={-1}
      className="min-w-0 rounded border border-border bg-card"
      aria-label={`HTML render: ${reference.title}`}
    >
      <div className="flex items-center justify-between gap-2 border-b border-border p-2">
        <span className="truncate text-sm">{reference.title}</span>
        <Button size="xs" disabled={!document} onClick={() => setFullscreen(true)}>
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
      ) : !document ? (
        // Holds the page's own height, so the thread does not jump when it loads.
        <Skeleton
          role="status"
          aria-label="Loading page…"
          className="m-2 rounded-lg"
          style={{ height: `${Math.max(0, height - 16)}px` }}
        />
      ) : null}
      {!fullscreen ? iframe : null}
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
          <div className="min-h-0 flex-1 overflow-auto">{fullscreen ? iframe : null}</div>
        </DialogPopup>
      </Dialog>
    </div>
  );
}
