import {
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
  type DiscoveredLocalServer,
  type PreviewAnnotationPayload,
  type PreviewEvent,
  type PreviewNavStatus,
  type PreviewSessionSnapshot,
  type ThreadId,
} from "@t3tools/contracts";
import {
  ArrowLeftIcon,
  ArrowRightIcon,
  BugIcon,
  ExternalLinkIcon,
  Globe2Icon,
  MousePointer2Icon,
  RefreshCcwIcon,
  RotateCcwIcon,
  XIcon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { type ComposerImageAttachment, useComposerDraftStore } from "../composerDraftStore";
import { cn, randomUUID } from "../lib/utils";
import { ensureNativeApi } from "../nativeApi";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Spinner } from "./ui/spinner";
import { toastManager } from "./ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";

type PreviewWebviewElement = HTMLElement & {
  getWebContentsId?: () => number;
  getURL?: () => string;
  getTitle?: () => string;
  canGoBack?: () => boolean;
  canGoForward?: () => boolean;
  isLoading?: () => boolean;
};

interface PreviewPanelProps {
  threadId: ThreadId;
  onClose: () => void;
}

function navStatusUrl(navStatus: PreviewNavStatus): string {
  return navStatus._tag === "Idle" ? "" : navStatus.url;
}

function navStatusTitle(navStatus: PreviewNavStatus): string {
  return navStatus._tag === "Idle" ? "" : navStatus.title;
}

function dataUrlToFile(dataUrl: string, name: string): File {
  const [metadata = "", payload = ""] = dataUrl.split(",", 2);
  const mimeMatch = /^data:([^;]+);base64$/i.exec(metadata);
  const mimeType = mimeMatch?.[1] ?? "image/png";
  const binary = atob(payload);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return new File([bytes], name, { type: mimeType });
}

function summarizeAnnotation(annotation: PreviewAnnotationPayload): string {
  const target = annotation.elements[0] ?? null;
  const element = target?.element ?? null;
  const lines = [
    "Preview annotation:",
    `URL: ${annotation.pageUrl}`,
    element?.tagName ? `Element: <${element.tagName}>` : null,
    element?.selector ? `Selector: ${element.selector}` : null,
    element?.textPreview ? `Text: ${element.textPreview}` : null,
  ].filter((line): line is string => line !== null);
  return lines.join("\n");
}

function appendAnnotationToComposer(
  threadId: ThreadId,
  annotation: PreviewAnnotationPayload,
): void {
  const store = useComposerDraftStore.getState();
  const existingPrompt = store.draftsByThreadId[threadId]?.prompt ?? "";
  const annotationText = summarizeAnnotation(annotation);
  store.setPrompt(
    threadId,
    existingPrompt.trim().length > 0
      ? `${existingPrompt.trimEnd()}\n\n${annotationText}`
      : annotationText,
  );

  const screenshot = annotation.screenshot;
  if (!screenshot) {
    toastManager.add({
      type: "success",
      title: "Preview annotation added",
      description: "Element context was added to the composer.",
    });
    return;
  }

  const existingImages = store.draftsByThreadId[threadId]?.images ?? [];
  if (existingImages.length >= PROVIDER_SEND_TURN_MAX_ATTACHMENTS) {
    toastManager.add({
      type: "warning",
      title: "Preview annotation added without screenshot",
      description: `The composer already has ${PROVIDER_SEND_TURN_MAX_ATTACHMENTS} images.`,
    });
    return;
  }

  const file = dataUrlToFile(screenshot.dataUrl, `preview-annotation-${Date.now()}.png`);
  if (file.size > PROVIDER_SEND_TURN_MAX_IMAGE_BYTES) {
    toastManager.add({
      type: "warning",
      title: "Preview annotation added without screenshot",
      description: "The captured image exceeds the attachment limit.",
    });
    return;
  }

  const image: ComposerImageAttachment = {
    type: "image",
    id: randomUUID(),
    name: file.name,
    mimeType: file.type,
    sizeBytes: file.size,
    previewUrl: URL.createObjectURL(file),
    file,
  };
  store.addImage(threadId, image);
  toastManager.add({
    type: "success",
    title: "Preview annotation attached",
    description: "Screenshot and element context were added to the composer.",
  });
}

function applyPreviewEvent(
  sessions: ReadonlyArray<PreviewSessionSnapshot>,
  event: PreviewEvent,
): PreviewSessionSnapshot[] {
  switch (event.type) {
    case "opened":
    case "navigated":
      return [
        ...sessions.filter((session) => session.tabId !== event.tabId),
        event.snapshot,
      ].toSorted((left, right) => left.updatedAt.localeCompare(right.updatedAt));
    case "failed":
      return sessions.map((session) =>
        session.tabId === event.tabId
          ? {
              ...session,
              navStatus: {
                _tag: "LoadFailed",
                url: event.url,
                title: event.title,
                code: event.code,
                description: event.description,
              },
              updatedAt: event.createdAt,
            }
          : session,
      );
    case "closed":
      return sessions.filter((session) => session.tabId !== event.tabId);
  }
}

function localServerLabel(server: DiscoveredLocalServer): string {
  return server.processName ? `${server.processName} :${server.port}` : `localhost:${server.port}`;
}

function PreviewUnavailable(props: { onClose: () => void }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col bg-background">
      <div className="flex h-11 shrink-0 items-center justify-between border-b border-border px-3">
        <div className="flex min-w-0 items-center gap-2">
          <Globe2Icon className="size-4 text-muted-foreground" />
          <span className="truncate text-sm font-medium">Preview</span>
        </div>
        <Button size="icon-sm" variant="ghost" onClick={props.onClose} aria-label="Close preview">
          <XIcon />
        </Button>
      </div>
      <div className="flex min-h-0 flex-1 items-center justify-center p-6 text-center">
        <div className="max-w-sm">
          <p className="text-sm font-medium text-foreground">Preview is desktop-only</p>
          <p className="mt-2 text-sm text-muted-foreground">
            Open F5 in the Electron desktop app to use the browser preview panel.
          </p>
        </div>
      </div>
    </div>
  );
}

export default function PreviewPanel({ threadId, onClose }: PreviewPanelProps) {
  const desktopPreview = window.desktopBridge?.preview;
  const api = useMemo(() => ensureNativeApi(), []);
  const webviewRef = useRef<PreviewWebviewElement | null>(null);
  const lastStatusReportKeyRef = useRef<string | null>(null);
  const [sessions, setSessions] = useState<PreviewSessionSnapshot[]>([]);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);
  const [webviewConfig, setWebviewConfig] = useState<{
    partition: string;
    webPreferences: string;
  } | null>(null);
  const [urlInput, setUrlInput] = useState("");
  const [localServers, setLocalServers] = useState<ReadonlyArray<DiscoveredLocalServer>>([]);
  const [localServersLoading, setLocalServersLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);

  const activeSession =
    sessions.find((session) => session.tabId === activeTabId) ?? sessions.at(-1) ?? null;
  const activeUrl = activeSession ? navStatusUrl(activeSession.navStatus) : "";
  const activeTitle = activeSession ? navStatusTitle(activeSession.navStatus) : "";
  const loading = activeSession?.navStatus._tag === "Loading";
  const canGoBack = activeSession?.canGoBack ?? false;
  const canGoForward = activeSession?.canGoForward ?? false;

  const refreshLocalServers = useCallback(async () => {
    setLocalServersLoading(true);
    try {
      const result = await api.preview.listLocalServers({});
      setLocalServers(result.servers);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLocalServersLoading(false);
    }
  }, [api]);

  useEffect(() => {
    if (!desktopPreview) {
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const [config, list] = await Promise.all([
          desktopPreview.getPreviewConfig(),
          api.preview.list({ threadId }),
        ]);
        if (cancelled) return;
        setWebviewConfig(config);
        if (list.sessions.length > 0) {
          setSessions([...list.sessions]);
          setActiveTabId((current) => current ?? list.sessions.at(-1)?.tabId ?? null);
          return;
        }
        const snapshot = await api.preview.open({ threadId });
        if (cancelled) return;
        setSessions([snapshot]);
        setActiveTabId(snapshot.tabId);
      } catch (cause) {
        if (!cancelled) {
          setError(cause instanceof Error ? cause.message : String(cause));
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [api, desktopPreview, threadId]);

  useEffect(() => {
    if (!desktopPreview) return;
    void refreshLocalServers();
    return api.preview.onLocalServersUpdated((event) => {
      setLocalServers(event.servers);
    });
  }, [api, desktopPreview, refreshLocalServers]);

  useEffect(() => {
    return api.preview.onEvent((event) => {
      if (event.threadId !== threadId) return;
      setSessions((current) => applyPreviewEvent(current, event));
      if (event.type === "opened" || event.type === "navigated") {
        setActiveTabId((current) => current ?? event.tabId);
      }
    });
  }, [api, threadId]);

  useEffect(() => {
    setUrlInput(activeUrl);
  }, [activeUrl]);

  useEffect(() => {
    if (!desktopPreview || !activeSession) return;
    void desktopPreview.createTab(activeSession.tabId);
  }, [activeSession, desktopPreview]);

  const reportWebviewStatus = useCallback(
    (navStatus: PreviewNavStatus) => {
      if (!activeSession) return;
      const webview = webviewRef.current;
      const report = {
        threadId,
        tabId: activeSession.tabId,
        navStatus,
        canGoBack: webview?.canGoBack?.() ?? false,
        canGoForward: webview?.canGoForward?.() ?? false,
      };
      const reportKey = JSON.stringify(report);
      if (lastStatusReportKeyRef.current === reportKey) {
        return;
      }
      lastStatusReportKeyRef.current = reportKey;
      void api.preview.reportStatus(report);
    },
    [activeSession, api, threadId],
  );

  useEffect(() => {
    const webview = webviewRef.current;
    if (!desktopPreview || !activeSession || !webview) return;

    const register = () => {
      const webContentsId = webview.getWebContentsId?.();
      if (typeof webContentsId === "number" && webContentsId > 0) {
        void desktopPreview.registerWebview(activeSession.tabId, webContentsId);
      }
    };
    const currentUrl = () => webview.getURL?.() || activeUrl || "about:blank";
    const currentTitle = () => webview.getTitle?.() || activeTitle || "";
    const onStart = () => {
      const url = currentUrl();
      if (!url || url === "about:blank") return;
      reportWebviewStatus({ _tag: "Loading", url, title: currentTitle() });
    };
    const onSuccess = () => {
      register();
      const url = currentUrl();
      if (!url || url === "about:blank") return;
      reportWebviewStatus({ _tag: "Success", url, title: currentTitle() });
    };
    const onFail = (event: Event) => {
      const failure = event as Event & {
        errorCode?: number;
        errorDescription?: string;
        validatedURL?: string;
      };
      if (failure.errorCode === -3) return;
      reportWebviewStatus({
        _tag: "LoadFailed",
        url: failure.validatedURL || currentUrl(),
        title: currentTitle(),
        code: failure.errorCode ?? 0,
        description: failure.errorDescription ?? "Navigation failed.",
      });
    };

    webview.addEventListener("dom-ready", register);
    webview.addEventListener("did-start-loading", onStart);
    webview.addEventListener("did-finish-load", onSuccess);
    webview.addEventListener("did-navigate", onSuccess);
    webview.addEventListener("did-navigate-in-page", onSuccess);
    webview.addEventListener("page-title-updated", onSuccess);
    webview.addEventListener("did-fail-load", onFail);
    register();

    return () => {
      webview.removeEventListener("dom-ready", register);
      webview.removeEventListener("did-start-loading", onStart);
      webview.removeEventListener("did-finish-load", onSuccess);
      webview.removeEventListener("did-navigate", onSuccess);
      webview.removeEventListener("did-navigate-in-page", onSuccess);
      webview.removeEventListener("page-title-updated", onSuccess);
      webview.removeEventListener("did-fail-load", onFail);
    };
  }, [activeSession, activeTitle, activeUrl, desktopPreview, reportWebviewStatus]);

  const navigateTo = useCallback(
    async (rawUrl: string) => {
      if (!activeSession || !desktopPreview) return;
      setError(null);
      try {
        const snapshot = await api.preview.navigate({
          threadId,
          tabId: activeSession.tabId,
          url: rawUrl,
        });
        setSessions((current) =>
          applyPreviewEvent(current, {
            type: "navigated",
            threadId,
            tabId: snapshot.tabId,
            createdAt: snapshot.updatedAt,
            snapshot,
          }),
        );
        const normalizedUrl = navStatusUrl(snapshot.navStatus);
        if (normalizedUrl) {
          await desktopPreview.navigate(activeSession.tabId, normalizedUrl);
        }
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
      }
    },
    [activeSession, api, desktopPreview, threadId],
  );

  const closePreview = useCallback(async () => {
    if (activeSession) {
      await api.preview.close({ threadId, tabId: activeSession.tabId }).catch(() => undefined);
      await desktopPreview?.closeTab(activeSession.tabId).catch(() => undefined);
    }
    onClose();
  }, [activeSession, api, desktopPreview, onClose, threadId]);

  const pickElement = useCallback(async () => {
    if (!activeSession || !desktopPreview) return;
    setPicking(true);
    setError(null);
    try {
      const annotation = await desktopPreview.pickElement(activeSession.tabId);
      if (annotation) {
        appendAnnotationToComposer(threadId, annotation);
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setPicking(false);
    }
  }, [activeSession, desktopPreview, threadId]);

  if (!desktopPreview) {
    return <PreviewUnavailable onClose={onClose} />;
  }

  const webviewSrc = activeUrl || "about:blank";

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-background">
      <div className="flex h-11 shrink-0 items-center gap-1 border-b border-border px-2">
        <Button
          size="icon-sm"
          variant="ghost"
          onClick={() => activeSession && void desktopPreview.goBack(activeSession.tabId)}
          disabled={!activeSession || !canGoBack}
          aria-label="Back"
        >
          <ArrowLeftIcon />
        </Button>
        <Button
          size="icon-sm"
          variant="ghost"
          onClick={() => activeSession && void desktopPreview.goForward(activeSession.tabId)}
          disabled={!activeSession || !canGoForward}
          aria-label="Forward"
        >
          <ArrowRightIcon />
        </Button>
        <Button
          size="icon-sm"
          variant="ghost"
          onClick={() => {
            if (!activeSession) return;
            void api.preview.refresh({ threadId, tabId: activeSession.tabId });
            void desktopPreview.refresh(activeSession.tabId);
          }}
          disabled={!activeSession}
          aria-label="Reload"
        >
          {loading ? <Spinner className="size-4" /> : <RefreshCcwIcon />}
        </Button>
        <form
          className="min-w-0 flex-1"
          onSubmit={(event) => {
            event.preventDefault();
            void navigateTo(urlInput);
          }}
        >
          <Input
            nativeInput
            size="sm"
            value={urlInput}
            onChange={(event) => setUrlInput(event.currentTarget.value)}
            placeholder="localhost:5173"
            aria-label="Preview URL"
          />
        </form>
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                size="icon-sm"
                variant="ghost"
                onClick={pickElement}
                disabled={!activeSession || picking}
                aria-label="Pick element"
              >
                {picking ? <Spinner className="size-4" /> : <MousePointer2Icon />}
              </Button>
            }
          />
          <TooltipPopup>Pick element</TooltipPopup>
        </Tooltip>
        <Button
          size="icon-sm"
          variant="ghost"
          onClick={() => activeUrl && void window.desktopBridge?.openExternal(activeUrl)}
          disabled={!activeUrl}
          aria-label="Open externally"
        >
          <ExternalLinkIcon />
        </Button>
        <Button
          size="icon-sm"
          variant="ghost"
          onClick={() => activeSession && void desktopPreview.hardReload(activeSession.tabId)}
          disabled={!activeSession}
          aria-label="Hard reload"
        >
          <RotateCcwIcon />
        </Button>
        <Button
          size="icon-sm"
          variant="ghost"
          onClick={() => activeSession && void desktopPreview.openDevTools(activeSession.tabId)}
          disabled={!activeSession}
          aria-label="Open DevTools"
        >
          <BugIcon />
        </Button>
        <Button
          size="icon-sm"
          variant="ghost"
          onClick={() => void closePreview()}
          aria-label="Close preview"
        >
          <XIcon />
        </Button>
      </div>

      {error && (
        <div className="border-b border-destructive/20 bg-destructive/8 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      )}

      <div className="relative min-h-0 flex-1 bg-muted/20">
        {activeSession && webviewConfig ? (
          <>
            <webview
              key={activeSession.tabId}
              ref={(node) => {
                webviewRef.current = node as PreviewWebviewElement | null;
              }}
              src={webviewSrc}
              partition={webviewConfig.partition}
              webpreferences={webviewConfig.webPreferences}
              className="h-full w-full bg-background"
            />
            {activeSession.navStatus._tag === "LoadFailed" && (
              <div className="absolute inset-0 flex items-center justify-center bg-background/92 p-6 text-center">
                <div className="max-w-sm">
                  <p className="text-sm font-medium text-foreground">Preview failed to load</p>
                  <p className="mt-2 text-sm text-muted-foreground">
                    {activeSession.navStatus.description}
                  </p>
                </div>
              </div>
            )}
          </>
        ) : (
          <div className="flex h-full items-center justify-center">
            <Spinner className="size-5 text-muted-foreground" />
          </div>
        )}

        {!activeUrl && (
          <div className="absolute inset-0 overflow-y-auto bg-background p-4">
            <div className="mx-auto max-w-md space-y-3">
              <div className="flex items-center justify-between">
                <p className="text-sm font-medium text-foreground">Local servers</p>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => void refreshLocalServers()}
                  disabled={localServersLoading}
                >
                  {localServersLoading ? <Spinner className="size-3.5" /> : <RefreshCcwIcon />}
                  Refresh
                </Button>
              </div>
              <div className="space-y-2">
                {localServers.map((server) => (
                  <button
                    key={`${server.host}:${server.port}`}
                    type="button"
                    className={cn(
                      "flex w-full items-center justify-between gap-3 rounded-md border border-border/80 bg-card/55 px-3 py-2 text-left",
                      "transition hover:border-border hover:bg-accent/50",
                    )}
                    onClick={() => void navigateTo(server.url)}
                  >
                    <span className="min-w-0">
                      <span className="block truncate text-sm font-medium">
                        {localServerLabel(server)}
                      </span>
                      <span className="block truncate text-xs text-muted-foreground">
                        {server.url}
                      </span>
                    </span>
                    <Globe2Icon className="size-4 shrink-0 text-muted-foreground" />
                  </button>
                ))}
                {!localServersLoading && localServers.length === 0 && (
                  <div className="rounded-md border border-border/80 bg-card/40 px-3 py-6 text-center text-sm text-muted-foreground">
                    No local servers found.
                  </div>
                )}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
