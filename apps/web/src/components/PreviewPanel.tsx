import {
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
  type DiscoveredLocalServer,
  type PreviewAutomationClickInput,
  type PreviewAutomationEvaluateInput,
  type PreviewAutomationNavigateInput,
  type PreviewAutomationOpenInput,
  type PreviewAutomationPressInput,
  type PreviewAutomationRequest,
  type PreviewAutomationResponse,
  type PreviewAutomationScrollInput,
  type PreviewAutomationStatus,
  type PreviewAutomationTypeInput,
  type PreviewAutomationWaitForInput,
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
import {
  readReadyWebContentsId,
  readReadyWebviewValue,
  type PreviewWebviewReaderElement,
} from "./PreviewPanel.logic";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Spinner } from "./ui/spinner";
import { toastManager } from "./ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";

type PreviewWebviewElement = HTMLElement &
  PreviewWebviewReaderElement & {
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

const PREVIEW_AUTOMATION_ATTACHMENT_POLL_INTERVAL_MS = 100;

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

function previewAutomationStatusUnavailable(): PreviewAutomationStatus {
  return {
    available: false,
    visible: false,
    tabId: null,
    url: null,
    title: null,
    loading: false,
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function previewAutomationErrorResponse(
  requestId: string,
  cause: unknown,
): PreviewAutomationResponse {
  const message = cause instanceof Error ? cause.message : String(cause);
  const tagged =
    cause && typeof cause === "object" && "_tag" in cause && typeof cause._tag === "string"
      ? (cause as { _tag: string; detail?: unknown })
      : null;
  return {
    requestId,
    ok: false,
    error: {
      _tag: tagged?._tag ?? "PreviewAutomationExecutionError",
      message,
      ...(tagged?.detail !== undefined ? { detail: tagged.detail } : {}),
    },
  };
}

function makePreviewAutomationError(
  _tag: string,
  message: string,
  detail?: unknown,
): Error & {
  _tag: string;
  detail?: unknown;
} {
  const error = new Error(message) as Error & { _tag: string; detail?: unknown };
  error._tag = _tag;
  if (detail !== undefined) {
    error.detail = detail;
  }
  return error;
}

function withPreviewAutomationTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | null = null;
  return new Promise<T>((resolve, reject) => {
    timeout = setTimeout(() => {
      reject(makePreviewAutomationError("PreviewAutomationTimeoutError", message));
    }, timeoutMs);
    promise.then(
      (value) => {
        if (timeout) clearTimeout(timeout);
        resolve(value);
      },
      (cause) => {
        if (timeout) clearTimeout(timeout);
        reject(cause);
      },
    );
  });
}

function resolveAutomationNavigateUrl(input: PreviewAutomationNavigateInput): string {
  if (input.url) return input.url;
  const target = input.target;
  if (!target) {
    throw makePreviewAutomationError(
      "PreviewAutomationExecutionError",
      "Preview navigation target is missing.",
    );
  }
  if (target.kind === "url") {
    return target.url;
  }
  const protocol = target.protocol ?? "http";
  const targetPath = target.path && target.path.length > 0 ? target.path : "/";
  const normalizedPath = targetPath.startsWith("/") ? targetPath : `/${targetPath}`;
  return `${protocol}://127.0.0.1:${target.port}${normalizedPath}`;
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
  const automationClientIdRef = useRef(`preview-${randomUUID()}`);
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
  const previewAutomation = desktopPreview?.automation;

  useEffect(() => {
    if (!desktopPreview) return;
    const clientId = automationClientIdRef.current;
    return () => {
      void api.preview.automation.clearOwner({ clientId }).catch(() => undefined);
    };
  }, [api, desktopPreview]);

  useEffect(() => {
    if (!desktopPreview) return;
    void api.preview.automation
      .reportOwner({
        clientId: automationClientIdRef.current,
        threadId,
        tabId: activeSession?.tabId ?? null,
        visible: true,
        supportsAutomation: Boolean(previewAutomation),
        focusedAt: new Date().toISOString(),
      })
      .catch(() => undefined);
  }, [activeSession?.tabId, api, desktopPreview, previewAutomation, threadId]);

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
        canGoBack: readReadyWebviewValue(() => webview?.canGoBack?.(), false),
        canGoForward: readReadyWebviewValue(() => webview?.canGoForward?.(), false),
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
      const webContentsId = readReadyWebContentsId(webview);
      if (webContentsId !== null) {
        void desktopPreview.registerWebview(activeSession.tabId, webContentsId);
      }
    };
    const currentUrl = () =>
      readReadyWebviewValue(() => webview.getURL?.(), activeUrl || "about:blank");
    const currentTitle = () => readReadyWebviewValue(() => webview.getTitle?.(), activeTitle);
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

  const runAutomationRequest = useCallback(
    async (request: PreviewAutomationRequest): Promise<unknown> => {
      if (!desktopPreview || !previewAutomation) {
        throw makePreviewAutomationError(
          "PreviewAutomationUnsupportedClientError",
          "Preview automation is only available in the Electron desktop app.",
        );
      }

      const statusForTab = (tabId: string | null | undefined) =>
        tabId
          ? previewAutomation.status(tabId)
          : Promise.resolve(previewAutomationStatusUnavailable());
      const waitForAttachedTab = async (tabId: string): Promise<PreviewAutomationStatus> => {
        const deadline = Date.now() + request.timeoutMs;
        let lastStatus: PreviewAutomationStatus | null = null;
        while (Date.now() < deadline) {
          try {
            const status = await previewAutomation.status(tabId);
            lastStatus = status;
            if (status.available) {
              return status;
            }
          } catch {
            lastStatus = null;
          }
          await delay(PREVIEW_AUTOMATION_ATTACHMENT_POLL_INTERVAL_MS);
        }
        throw makePreviewAutomationError(
          "PreviewAutomationTimeoutError",
          lastStatus?.tabId
            ? `Preview webview was not attached after ${request.timeoutMs}ms.`
            : `Preview tab was not attached after ${request.timeoutMs}ms.`,
        );
      };
      const requireTabId = (): string => {
        const tabId = request.tabId ?? activeSession?.tabId;
        if (!tabId) {
          throw makePreviewAutomationError(
            "PreviewAutomationTabNotFoundError",
            "The preview does not have an active tab.",
          );
        }
        return tabId;
      };

      switch (request.operation) {
        case "status":
          return statusForTab(request.tabId ?? activeSession?.tabId);

        case "open": {
          const input = request.input as PreviewAutomationOpenInput;
          let session = activeSession;
          let createdSession = false;
          if (!session || input.reuseExistingTab === false) {
            const openedSession = await api.preview.open({
              threadId,
              ...(input.url ? { url: input.url } : {}),
            });
            session = openedSession;
            createdSession = true;
            await desktopPreview.createTab(openedSession.tabId);
            setSessions((current) =>
              applyPreviewEvent(current, {
                type: "opened",
                threadId,
                tabId: openedSession.tabId,
                createdAt: openedSession.updatedAt,
                snapshot: openedSession,
              }),
            );
            setActiveTabId(openedSession.tabId);
          }
          if (!session) {
            throw makePreviewAutomationError(
              "PreviewAutomationTabNotFoundError",
              "The preview does not have an active tab.",
            );
          }

          if (input.url) {
            const snapshot = await api.preview.navigate({
              threadId,
              tabId: session.tabId,
              url: input.url,
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
            if (normalizedUrl && !createdSession) {
              await desktopPreview.navigate(session.tabId, normalizedUrl);
            }
          } else {
            const sessionUrl = navStatusUrl(session.navStatus);
            if (sessionUrl && !createdSession) {
              await desktopPreview.navigate(session.tabId, sessionUrl);
            }
          }

          return createdSession ? waitForAttachedTab(session.tabId) : statusForTab(session.tabId);
        }

        case "navigate": {
          const tabId = requireTabId();
          const input = request.input as PreviewAutomationNavigateInput;
          const url = resolveAutomationNavigateUrl(input);
          const snapshot = await api.preview.navigate({ threadId, tabId, url });
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
            await desktopPreview.navigate(tabId, normalizedUrl);
          }
          return statusForTab(tabId);
        }

        case "snapshot":
          return previewAutomation.snapshot(requireTabId());
        case "click":
          await previewAutomation.click(
            requireTabId(),
            request.input as PreviewAutomationClickInput,
          );
          return null;
        case "type":
          await previewAutomation.type(requireTabId(), request.input as PreviewAutomationTypeInput);
          return null;
        case "press":
          await previewAutomation.press(
            requireTabId(),
            request.input as PreviewAutomationPressInput,
          );
          return null;
        case "scroll":
          await previewAutomation.scroll(
            requireTabId(),
            request.input as PreviewAutomationScrollInput,
          );
          return null;
        case "evaluate": {
          try {
            return await withPreviewAutomationTimeout(
              previewAutomation.evaluate(
                requireTabId(),
                request.input as PreviewAutomationEvaluateInput,
              ),
              request.timeoutMs,
              `Preview evaluation timed out after ${request.timeoutMs}ms.`,
            );
          } catch (cause) {
            const message = cause instanceof Error ? cause.message : String(cause);
            if (/Preview evaluation timed out after \d+ms\./.test(message)) {
              throw makePreviewAutomationError("PreviewAutomationTimeoutError", message);
            }
            throw cause;
          }
        }
        case "waitFor":
          await previewAutomation.waitFor(
            requireTabId(),
            request.input as PreviewAutomationWaitForInput,
          );
          return null;
      }
    },
    [activeSession, api, desktopPreview, previewAutomation, threadId],
  );

  useEffect(() => {
    if (!desktopPreview) return;
    return api.preview.automation.onRequest((request) => {
      if (request.threadId !== threadId) return;
      void (async () => {
        try {
          const result = await runAutomationRequest(request);
          await api.preview.automation.respond({
            requestId: request.requestId,
            ok: true,
            ...(result !== undefined ? { result } : {}),
          });
        } catch (cause) {
          await api.preview.automation.respond(
            previewAutomationErrorResponse(request.requestId, cause),
          );
        }
      })();
    });
  }, [api, desktopPreview, runAutomationRequest, threadId]);

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
