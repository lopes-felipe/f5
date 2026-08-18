import {
  type DesktopPreviewBridge,
  type DesktopPreviewTabState,
  type DesktopPreviewWebviewConfig,
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
  type PreviewAutomationViewportInput,
  type PreviewArtifact,
  type PreviewAnnotationPayload,
  type PreviewEvent,
  type PreviewNavStatus,
  type PreviewRecentLocation,
  type PreviewSessionSnapshot,
  type ThreadId,
} from "@t3tools/contracts";
import {
  ArrowLeftIcon,
  ArrowRightIcon,
  BugIcon,
  CameraIcon,
  CircleStopIcon,
  ExternalLinkIcon,
  Globe2Icon,
  LinkIcon,
  MousePointer2Icon,
  RefreshCcwIcon,
  RotateCcwIcon,
  ScalingIcon,
  UnlinkIcon,
  VideoIcon,
  XIcon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useComposerDraftStore } from "../composerDraftStore";
import { cn, randomUUID } from "../lib/utils";
import { ensureNativeApi } from "../nativeApi";
import { usePreviewPresentationStore } from "../previewPresentationStore";
import {
  readReadyWebContentsId,
  readReadyWebviewValue,
  type PreviewWebviewReaderElement,
} from "./PreviewPanel.logic";
import { PreviewAutomationResponseCache } from "./PreviewAutomationResponseCache";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Spinner } from "./ui/spinner";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "./ui/select";
import { toastManager } from "./ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";
import {
  clampPreviewViewport,
  nearestPreviewViewportPreset,
  orientPreviewViewport,
  PREVIEW_VIEWPORT_PRESETS,
  resizePreviewViewport,
  type PreviewViewportDimensions,
  type PreviewViewportPresetId,
} from "./PreviewViewport.logic";

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
  visible?: boolean;
}

const PREVIEW_AUTOMATION_ATTACHMENT_POLL_INTERVAL_MS = 100;
const PREVIEW_RECORDING_MAX_PENDING_CHUNKS = 2;
const PREVIEW_RECORDING_MAX_CHUNK_BYTES = 4 * 1024 * 1024;
const PREVIEW_RECORDING_MAX_DURATION_MS = 5 * 60 * 1000;
const MAX_PREVIEW_RECENT_LOCATIONS = 20;

interface ActivePreviewRecording {
  readonly recordingId: string;
  readonly tabId: string;
  readonly bridge: NonNullable<DesktopPreviewBridge["recording"]>;
  readonly recorder: MediaRecorder;
  readonly unsubscribeFrames: () => void;
  readonly pendingUploads: Set<Promise<void>>;
  limitTimer: number;
  phase: "starting" | "active" | "stopping";
  failure: Error | null;
  droppedFrames: number;
  stopPromise: Promise<PreviewArtifact | null> | null;
}

function navStatusUrl(navStatus: PreviewNavStatus): string {
  return navStatus._tag === "Idle" ? "" : navStatus.url;
}

function navStatusTitle(navStatus: PreviewNavStatus): string {
  return navStatus._tag === "Idle" ? "" : navStatus.title;
}

function previewPresentationTitle(title: string, url: string): string {
  if (title.trim().length > 0) return title.trim();
  try {
    return new URL(url).host || "Preview";
  } catch {
    return "Preview";
  }
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

async function appendAnnotationToComposer(
  threadId: ThreadId,
  annotation: PreviewAnnotationPayload,
): Promise<void> {
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

  const file = dataUrlToFile(screenshot.dataUrl, `preview-annotation-${Date.now()}.png`);
  const result = await store.importImages(threadId, [file]);
  if (result.cancelled) return;
  if (result.imported.length === 0) {
    toastManager.add({
      type: "warning",
      title: "Preview annotation added without screenshot",
      description: result.failures[0]?.message ?? "The captured image could not be attached.",
    });
    return;
  }
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

function rememberPreviewLocation(
  current: ReadonlyArray<PreviewRecentLocation>,
  location: PreviewRecentLocation,
): PreviewRecentLocation[] {
  return [location, ...current.filter((candidate) => candidate.url !== location.url)].slice(
    0,
    MAX_PREVIEW_RECENT_LOCATIONS,
  );
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
  request: PreviewAutomationRequest,
  cause: unknown,
): PreviewAutomationResponse {
  const message = cause instanceof Error ? cause.message : String(cause);
  const tagged =
    cause && typeof cause === "object" && "_tag" in cause && typeof cause._tag === "string"
      ? (cause as { _tag: string; detail?: unknown })
      : null;
  return {
    requestId: request.requestId,
    ...(request.clientId ? { clientId: request.clientId } : {}),
    ...(request.connectionId ? { connectionId: request.connectionId } : {}),
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

function PreviewBrowserWebview(props: {
  readonly session: PreviewSessionSnapshot;
  readonly visible: boolean;
  readonly config: DesktopPreviewWebviewConfig;
  readonly desktopPreview: DesktopPreviewBridge;
  readonly dimensions: PreviewViewportDimensions | null;
  readonly hiddenDimensions: PreviewViewportDimensions;
  readonly onStatus: (
    session: PreviewSessionSnapshot,
    webview: PreviewWebviewElement,
    navStatus: PreviewNavStatus,
  ) => void;
}) {
  const webviewRef = useRef<PreviewWebviewElement | null>(null);
  const sessionRef = useRef(props.session);
  sessionRef.current = props.session;
  const activeUrl = navStatusUrl(props.session.navStatus);
  const activeTitle = navStatusTitle(props.session.navStatus);
  const activeUrlRef = useRef(activeUrl);
  const activeTitleRef = useRef(activeTitle);
  activeUrlRef.current = activeUrl;
  activeTitleRef.current = activeTitle;

  useEffect(() => {
    void props.desktopPreview.createTab(props.session.tabId);
  }, [props.desktopPreview, props.session.tabId]);

  useEffect(() => {
    void props.desktopPreview
      .setColorScheme(props.session.tabId, props.session.colorScheme ?? "system")
      .catch(() => undefined);
  }, [props.desktopPreview, props.session.colorScheme, props.session.tabId]);

  useEffect(() => {
    const webview = webviewRef.current;
    if (!webview) return;
    const register = () => {
      const webContentsId = readReadyWebContentsId(webview);
      if (webContentsId !== null) {
        void props.desktopPreview
          .registerWebview(props.session.tabId, webContentsId)
          .then(() =>
            props.desktopPreview.setColorScheme(
              props.session.tabId,
              sessionRef.current.colorScheme ?? "system",
            ),
          )
          .catch(() => undefined);
      }
    };
    const currentUrl = () =>
      readReadyWebviewValue(() => webview.getURL?.(), activeUrlRef.current || "about:blank");
    const currentTitle = () =>
      readReadyWebviewValue(() => webview.getTitle?.(), activeTitleRef.current);
    const onStart = () => {
      const url = currentUrl();
      if (url && url !== "about:blank") {
        props.onStatus(sessionRef.current, webview, {
          _tag: "Loading",
          url,
          title: currentTitle(),
        });
      }
    };
    const onSuccess = () => {
      register();
      const url = currentUrl();
      if (url && url !== "about:blank") {
        props.onStatus(sessionRef.current, webview, {
          _tag: "Success",
          url,
          title: currentTitle(),
        });
      }
    };
    const onFail = (event: Event) => {
      const failure = event as Event & {
        errorCode?: number;
        errorDescription?: string;
        validatedURL?: string;
      };
      if (failure.errorCode === -3) return;
      props.onStatus(sessionRef.current, webview, {
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
  }, [props.desktopPreview, props.onStatus, props.session.tabId]);

  const dimensions = props.dimensions ?? props.hiddenDimensions;
  return (
    <div
      aria-hidden={!props.visible}
      inert={!props.visible || undefined}
      className={cn(
        "bg-background",
        props.visible
          ? "relative overflow-hidden"
          : "pointer-events-none fixed top-0 -left-[100000px] opacity-0",
      )}
      style={
        props.visible && props.dimensions === null
          ? { width: "100%", height: "100%" }
          : { width: dimensions.width, height: dimensions.height }
      }
    >
      <webview
        ref={(node) => {
          webviewRef.current = node as PreviewWebviewElement | null;
        }}
        src={activeUrl || "about:blank"}
        partition={props.config.partition}
        webpreferences={props.config.webPreferences}
        className="h-full w-full bg-background"
      />
      {props.visible && props.session.navStatus._tag === "LoadFailed" ? (
        <div className="absolute inset-0 flex items-center justify-center bg-background/92 p-6 text-center">
          <div className="max-w-sm">
            <p className="text-sm font-medium text-foreground">Preview failed to load</p>
            <p className="mt-2 text-sm text-muted-foreground">
              {props.session.navStatus.description}
            </p>
          </div>
        </div>
      ) : null}
    </div>
  );
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

export default function PreviewPanel({ threadId, onClose, visible = true }: PreviewPanelProps) {
  const desktopPreview = window.desktopBridge?.preview;
  const api = useMemo(() => ensureNativeApi(), []);
  const automationClientIdRef = useRef(`preview-${randomUUID()}`);
  const automationConnectionIdRef = useRef<string | null>(null);
  const automationOwnerReportTailRef = useRef<Promise<void>>(Promise.resolve());
  const lastStatusReportKeyRef = useRef(new Map<string, string>());
  const viewportContainerRef = useRef<HTMLDivElement | null>(null);
  const viewportRevisionRef = useRef(new Map<string, number>());
  const viewportPersistTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingViewportPersistRef = useRef<{
    tabId: string;
    dimensions: PreviewViewportDimensions;
  } | null>(null);
  const viewportDragRef = useRef<{
    pointerId: number;
    tabId: string;
    startX: number;
    startY: number;
    width: number;
    height: number;
    linked: boolean;
  } | null>(null);
  const lastViewportPersistAtRef = useRef(0);
  const activeRecordingRef = useRef<ActivePreviewRecording | null>(null);
  const automationResponseCacheRef = useRef(new PreviewAutomationResponseCache());
  const [sessions, setSessions] = useState<PreviewSessionSnapshot[]>([]);
  const sessionsRef = useRef<PreviewSessionSnapshot[]>([]);
  sessionsRef.current = sessions;
  const [activeTabId, setActiveTabId] = useState<string | null>(null);
  const [webviewConfig, setWebviewConfig] = useState<{
    partition: string;
    webPreferences: string;
  } | null>(null);
  const [urlInput, setUrlInput] = useState("");
  const [localServers, setLocalServers] = useState<ReadonlyArray<DiscoveredLocalServer>>([]);
  const [recentLocations, setRecentLocations] = useState<ReadonlyArray<PreviewRecentLocation>>([]);
  const [desktopStateByTabId, setDesktopStateByTabId] = useState<
    Record<string, DesktopPreviewTabState | undefined>
  >({});
  const [localServersLoading, setLocalServersLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);
  const [viewportBounds, setViewportBounds] = useState<PreviewViewportDimensions>({
    width: 1280,
    height: 720,
  });
  const [requestedViewportByTabId, setRequestedViewportByTabId] = useState<
    Record<string, PreviewViewportDimensions | null>
  >({});
  const [viewportPresetByTabId, setViewportPresetByTabId] = useState<
    Record<string, PreviewViewportPresetId | "custom">
  >({});
  const [viewportLinkedByTabId, setViewportLinkedByTabId] = useState<Record<string, boolean>>({});
  const [recordingTabId, setRecordingTabId] = useState<string | null>(null);

  const activeSession =
    sessions.find((session) => session.tabId === activeTabId) ?? sessions.at(-1) ?? null;
  const activeUrl = activeSession ? navStatusUrl(activeSession.navStatus) : "";
  const activeDesktopState = activeSession ? desktopStateByTabId[activeSession.tabId] : undefined;
  const loading = activeSession?.navStatus._tag === "Loading";
  const canGoBack = activeSession?.canGoBack ?? false;
  const canGoForward = activeSession?.canGoForward ?? false;
  const previewAutomation = desktopPreview?.automation;
  const automationOwnerStateRef = useRef({
    tabId: null as string | null,
    visible,
    supportsAutomation: false,
    supportsRecording: false,
  });
  automationOwnerStateRef.current = {
    tabId: activeSession?.tabId ?? null,
    visible,
    supportsAutomation: Boolean(previewAutomation),
    supportsRecording: Boolean(desktopPreview?.recording),
  };
  const requestedViewport = activeSession
    ? (requestedViewportByTabId[activeSession.tabId] ?? null)
    : null;
  const viewportLinked = activeSession
    ? (viewportLinkedByTabId[activeSession.tabId] ?? activeSession.viewportLinked ?? true)
    : true;
  const activeViewport = useMemo(
    () =>
      requestedViewport
        ? clampPreviewViewport({ requested: requestedViewport, bounds: viewportBounds })
        : null,
    [requestedViewport, viewportBounds],
  );

  const commitViewport = useCallback(
    (tabId: string, dimensions: PreviewViewportDimensions | null) => {
      if (!desktopPreview) return;
      const currentSession = sessionsRef.current.find((session) => session.tabId === tabId);
      const currentViewport = currentSession?.viewport ?? null;
      if (
        (dimensions === null && currentViewport === null) ||
        (dimensions !== null &&
          currentViewport !== null &&
          dimensions.width === currentViewport.width &&
          dimensions.height === currentViewport.height)
      ) {
        return;
      }
      const revision = (viewportRevisionRef.current.get(tabId) ?? 0) + 1;
      viewportRevisionRef.current.set(tabId, revision);
      lastViewportPersistAtRef.current = Date.now();
      const viewport = dimensions ? { ...dimensions, revision } : null;
      setSessions((current) =>
        current.map((session) => (session.tabId === tabId ? { ...session, viewport } : session)),
      );
      void desktopPreview.setViewport(tabId, viewport).catch(() => undefined);
      const session = sessionsRef.current.find((candidate) => candidate.tabId === tabId);
      if (session) {
        void api.preview.reportStatus({
          threadId,
          tabId: session.tabId,
          navStatus: session.navStatus,
          canGoBack: session.canGoBack,
          canGoForward: session.canGoForward,
          colorScheme: session.colorScheme,
          viewport,
          viewportLinked: viewportLinkedByTabId[tabId] ?? session.viewportLinked ?? true,
        });
      }
    },
    [api, desktopPreview, threadId, viewportLinkedByTabId],
  );

  const persistViewport = useCallback(
    (tabId: string, dimensions: PreviewViewportDimensions, final: boolean) => {
      pendingViewportPersistRef.current = { tabId, dimensions };
      if (final) {
        if (viewportPersistTimerRef.current) clearTimeout(viewportPersistTimerRef.current);
        viewportPersistTimerRef.current = null;
        pendingViewportPersistRef.current = null;
        commitViewport(tabId, dimensions);
        return;
      }
      const elapsed = Date.now() - lastViewportPersistAtRef.current;
      if (elapsed >= 100) {
        pendingViewportPersistRef.current = null;
        commitViewport(tabId, dimensions);
        return;
      }
      if (viewportPersistTimerRef.current) return;
      viewportPersistTimerRef.current = setTimeout(() => {
        viewportPersistTimerRef.current = null;
        const pending = pendingViewportPersistRef.current;
        pendingViewportPersistRef.current = null;
        if (pending) commitViewport(pending.tabId, pending.dimensions);
      }, 100 - elapsed);
    },
    [commitViewport],
  );

  useEffect(() => {
    const element = viewportContainerRef.current;
    if (!element) return;
    const updateBounds = () => {
      setViewportBounds({
        width: Math.max(320, element.clientWidth),
        height: Math.max(320, element.clientHeight),
      });
    };
    updateBounds();
    const observer = new ResizeObserver(updateBounds);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!activeSession || !activeViewport) return;
    persistViewport(activeSession.tabId, activeViewport, false);
  }, [activeSession?.tabId, activeViewport, persistViewport]);

  useEffect(
    () => () => {
      if (viewportPersistTimerRef.current) clearTimeout(viewportPersistTimerRef.current);
    },
    [],
  );

  const reportAutomationOwner = useCallback(() => {
    if (!desktopPreview) return Promise.resolve();
    const report = automationOwnerReportTailRef.current
      .catch(() => undefined)
      .then(async () => {
        const state = automationOwnerStateRef.current;
        const registration = await api.preview.automation.reportOwner({
          clientId: automationClientIdRef.current,
          ...(automationConnectionIdRef.current
            ? { connectionId: automationConnectionIdRef.current }
            : {}),
          threadId,
          tabId: state.tabId,
          visible: state.visible,
          supportsAutomation: state.supportsAutomation,
          capabilities: [
            ...(state.supportsAutomation ? (["automation"] as const) : []),
            "viewport" as const,
            "screenshot" as const,
            ...(state.supportsRecording ? (["recording"] as const) : []),
          ],
          focusedAt: new Date().toISOString(),
        });
        const previousConnectionId = automationConnectionIdRef.current;
        automationConnectionIdRef.current = registration.connectionId;
        if (previousConnectionId && previousConnectionId !== registration.connectionId) {
          automationResponseCacheRef.current.clear();
        }
      });
    automationOwnerReportTailRef.current = report;
    return report;
  }, [api, desktopPreview, threadId]);

  useEffect(() => {
    if (!desktopPreview) return;
    void reportAutomationOwner().catch(() => undefined);
    const renewInterval = window.setInterval(() => {
      void reportAutomationOwner().catch(() => undefined);
    }, 10_000);
    return () => {
      window.clearInterval(renewInterval);
      const clearOwner = automationOwnerReportTailRef.current
        .catch(() => undefined)
        .then(async () => {
          const connectionId = automationConnectionIdRef.current;
          automationConnectionIdRef.current = null;
          await api.preview.automation.clearOwner({
            clientId: automationClientIdRef.current,
            ...(connectionId ? { connectionId } : {}),
          });
        });
      automationOwnerReportTailRef.current = clearOwner;
      void clearOwner.catch(() => undefined);
    };
  }, [api, desktopPreview, reportAutomationOwner]);

  useEffect(() => {
    if (!desktopPreview) return;
    void reportAutomationOwner().catch(() => undefined);
  }, [activeSession?.tabId, desktopPreview, previewAutomation, reportAutomationOwner, visible]);

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
        setRecentLocations(list.recentLocations ?? []);
        const requested: Record<string, PreviewViewportDimensions | null> = {};
        const linked: Record<string, boolean> = {};
        for (const session of list.sessions) {
          requested[session.tabId] = session.viewport
            ? { width: session.viewport.width, height: session.viewport.height }
            : null;
          linked[session.tabId] = session.viewportLinked ?? true;
          if (session.viewport) {
            viewportRevisionRef.current.set(session.tabId, session.viewport.revision);
          }
        }
        setRequestedViewportByTabId(requested);
        setViewportLinkedByTabId(linked);
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
    if (!desktopPreview) return;
    return desktopPreview.onStateChange((tabId, state) => {
      setDesktopStateByTabId((current) => {
        const previous = current[tabId];
        return {
          ...current,
          [tabId]: {
            ...previous,
            ...state,
            ...(state.faviconDataUrl !== undefined
              ? { faviconDataUrl: state.faviconDataUrl }
              : previous?.faviconDataUrl !== undefined
                ? { faviconDataUrl: previous.faviconDataUrl }
                : {}),
          },
        };
      });
    });
  }, [desktopPreview]);

  useEffect(() => {
    if (!activeSession) return;
    const desktopStatus = activeDesktopState?.navStatus;
    const desktopUrl = desktopStatus?.kind === "Idle" ? "" : (desktopStatus?.url ?? "");
    const desktopTitle = desktopStatus?.kind === "Idle" ? "" : (desktopStatus?.title ?? "");
    const url = desktopUrl || activeUrl;
    const title = desktopTitle || navStatusTitle(activeSession.navStatus);
    usePreviewPresentationStore.getState().set(threadId, {
      title: previewPresentationTitle(title, url),
      url,
      faviconDataUrl: activeDesktopState?.faviconDataUrl ?? null,
    });
  }, [activeDesktopState, activeSession, activeUrl, threadId]);

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

  const reportWebviewStatus = useCallback(
    (
      session: PreviewSessionSnapshot,
      webview: PreviewWebviewElement,
      navStatus: PreviewNavStatus,
    ) => {
      const report = {
        threadId,
        tabId: session.tabId,
        navStatus,
        canGoBack: readReadyWebviewValue(() => webview.canGoBack?.(), false),
        canGoForward: readReadyWebviewValue(() => webview.canGoForward?.(), false),
        colorScheme: session.colorScheme,
        viewport: session.viewport,
        viewportLinked: session.viewportLinked,
      };
      const reportKey = JSON.stringify(report);
      if (lastStatusReportKeyRef.current.get(session.tabId) === reportKey) return;
      lastStatusReportKeyRef.current.set(session.tabId, reportKey);
      if (navStatus._tag === "Success") {
        setRecentLocations((current) =>
          rememberPreviewLocation(current, {
            url: navStatus.url,
            title: navStatus.title,
            visitedAt: new Date().toISOString(),
          }),
        );
      }
      void api.preview.reportStatus(report);
    },
    [api, threadId],
  );

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

  const captureScreenshot = useCallback(
    async (tabId: string): Promise<PreviewArtifact> => {
      if (!desktopPreview) throw new Error("Preview screenshots are unavailable.");
      const artifact = await desktopPreview.captureScreenshot(tabId);
      toastManager.add({
        type: "success",
        title: "Preview screenshot saved",
        description: `Artifact ${artifact.artifactId}`,
      });
      return artifact;
    },
    [desktopPreview],
  );

  const finalizePreviewRecording = useCallback(
    (recording: ActivePreviewRecording): Promise<PreviewArtifact | null> => {
      if (recording.phase === "stopping" && recording.stopPromise) {
        return recording.stopPromise;
      }
      recording.phase = "stopping";
      recording.unsubscribeFrames();
      window.clearTimeout(recording.limitTimer);
      const stopPromise = (async () => {
        const bridge = recording.bridge;
        try {
          if (recording.recorder.state !== "inactive") {
            await new Promise<void>((resolve) => {
              recording.recorder.addEventListener("stop", () => resolve(), { once: true });
              recording.recorder.stop();
            });
          }
          await Promise.all(recording.pendingUploads);
          if (recording.failure) throw recording.failure;
          if (recording.droppedFrames > 0) {
            await api.preview
              .reportRecordingMetrics({ droppedFrames: recording.droppedFrames })
              .catch(() => undefined);
          }
          const artifact = await bridge.stop(recording.recordingId);
          toastManager.add({
            type: "success",
            title: "Preview recording saved",
            description: `Artifact ${artifact.artifactId}`,
          });
          return artifact;
        } catch (cause) {
          await bridge.discard(recording.recordingId).catch(() => undefined);
          throw cause;
        } finally {
          if (activeRecordingRef.current === recording) activeRecordingRef.current = null;
          setRecordingTabId((current) => (current === recording.tabId ? null : current));
        }
      })();
      recording.stopPromise = stopPromise;
      return stopPromise;
    },
    [api, desktopPreview],
  );

  const startPreviewRecording = useCallback(
    async (tabId: string) => {
      const bridge = desktopPreview?.recording;
      if (!bridge) throw new Error("Preview recording is unavailable.");
      const current = activeRecordingRef.current;
      if (current) {
        if (current.tabId === tabId && current.phase !== "stopping") {
          return { recordingId: current.recordingId, tabId, startedAt: new Date().toISOString() };
        }
        throw new Error(`Preview tab ${current.tabId} is already recording.`);
      }

      const requested = requestedViewportByTabId[tabId];
      const dimensions = requested
        ? clampPreviewViewport({ requested, bounds: viewportBounds })
        : viewportBounds;
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.floor(dimensions.width));
      canvas.height = Math.max(1, Math.floor(dimensions.height));
      const context = canvas.getContext("2d");
      if (!context) throw new Error("Preview recording canvas is unavailable.");
      const mimeType = MediaRecorder.isTypeSupported("video/webm;codecs=vp9")
        ? "video/webm;codecs=vp9"
        : "video/webm";
      const recorder = new MediaRecorder(canvas.captureStream(12), {
        mimeType,
        videoBitsPerSecond: 6_000_000,
      });
      let recordingId: string | null = null;
      let drawingFrame = false;
      let recording: ActivePreviewRecording | null = null;
      const unsubscribeFrames = bridge.onFrame((frame) => {
        if (!recordingId || frame.recordingId !== recordingId || !recording) return;
        if (drawingFrame || recording.pendingUploads.size >= PREVIEW_RECORDING_MAX_PENDING_CHUNKS) {
          recording.droppedFrames += 1;
          return;
        }
        drawingFrame = true;
        const image = new Image();
        image.addEventListener(
          "load",
          () => {
            context.drawImage(image, 0, 0, canvas.width, canvas.height);
            drawingFrame = false;
          },
          { once: true },
        );
        image.addEventListener("error", () => (drawingFrame = false), { once: true });
        image.src = `data:image/jpeg;base64,${frame.data}`;
      });

      try {
        const started = await bridge.start(tabId);
        recordingId = started.recordingId;
        recording = {
          recordingId,
          tabId,
          bridge,
          recorder,
          unsubscribeFrames,
          pendingUploads: new Set(),
          limitTimer: 0,
          phase: "starting",
          failure: null,
          droppedFrames: 0,
          stopPromise: null,
        };
        const active = recording;
        recorder.addEventListener("dataavailable", (event) => {
          if (event.data.size === 0) return;
          if (
            event.data.size > PREVIEW_RECORDING_MAX_CHUNK_BYTES ||
            active.pendingUploads.size >= PREVIEW_RECORDING_MAX_PENDING_CHUNKS
          ) {
            active.failure = new Error("Preview recording backpressure limit exceeded.");
            void finalizePreviewRecording(active).catch(() => undefined);
            return;
          }
          const upload = event.data
            .arrayBuffer()
            .then((chunk) => bridge.appendChunk(active.recordingId, chunk))
            .catch((cause) => {
              active.failure = cause instanceof Error ? cause : new Error(String(cause));
            })
            .finally(() => active.pendingUploads.delete(upload));
          active.pendingUploads.add(upload);
        });
        activeRecordingRef.current = active;
        setRecordingTabId(tabId);
        recorder.start(1_000);
        active.phase = "active";
        active.limitTimer = window.setTimeout(() => {
          void finalizePreviewRecording(active).catch(() => undefined);
        }, PREVIEW_RECORDING_MAX_DURATION_MS);
        return started;
      } catch (cause) {
        unsubscribeFrames();
        if (recordingId) await bridge.discard(recordingId).catch(() => undefined);
        throw cause;
      }
    },
    [desktopPreview, finalizePreviewRecording, requestedViewportByTabId, viewportBounds],
  );

  const stopPreviewRecording = useCallback(
    (tabId?: string) => {
      const recording = activeRecordingRef.current;
      if (!recording || (tabId && recording.tabId !== tabId)) return Promise.resolve(null);
      return finalizePreviewRecording(recording);
    },
    [finalizePreviewRecording],
  );

  useEffect(
    () => () => {
      const recording = activeRecordingRef.current;
      if (!recording) return;
      recording.unsubscribeFrames();
      window.clearTimeout(recording.limitTimer);
      if (recording.recorder.state !== "inactive") recording.recorder.stop();
      void recording.bridge.discard(recording.recordingId).catch(() => undefined);
      activeRecordingRef.current = null;
    },
    [],
  );

  useEffect(() => {
    if (desktopPreview?.recording) return;
    const recording = activeRecordingRef.current;
    if (!recording) return;
    void finalizePreviewRecording(recording).catch(() => undefined);
  }, [desktopPreview?.recording, finalizePreviewRecording]);

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
        case "viewport": {
          const tabId = requireTabId();
          const input = request.input as PreviewAutomationViewportInput;
          const dimensions = clampPreviewViewport({ requested: input, bounds: viewportBounds });
          setRequestedViewportByTabId((current) => ({ ...current, [tabId]: dimensions }));
          setViewportPresetByTabId((current) => ({ ...current, [tabId]: "custom" }));
          persistViewport(tabId, dimensions, true);
          return dimensions;
        }
        case "screenshot":
          return captureScreenshot(requireTabId());
        case "recordingStart":
          return startPreviewRecording(requireTabId());
        case "recordingStop":
          return stopPreviewRecording(request.tabId ?? activeRecordingRef.current?.tabId);
      }
    },
    [
      activeSession,
      api,
      captureScreenshot,
      desktopPreview,
      persistViewport,
      previewAutomation,
      startPreviewRecording,
      stopPreviewRecording,
      threadId,
      viewportBounds,
    ],
  );

  useEffect(() => {
    if (!desktopPreview) return;
    return api.preview.automation.onRequest((request) => {
      if (request.threadId !== threadId) return;
      if (
        request.clientId !== automationClientIdRef.current ||
        request.connectionId !== automationConnectionIdRef.current
      ) {
        return;
      }
      void (async () => {
        const cache = automationResponseCacheRef.current;
        const cached = cache.lookup(request);
        if (cached.kind !== "miss") {
          if (cached.kind === "hit") {
            await api.preview.automation.respond(cached.response);
          } else {
            await api.preview.automation.respond(
              previewAutomationErrorResponse(
                request,
                makePreviewAutomationError(
                  "PreviewAutomationRequestReplayMismatchError",
                  "A preview request id was replayed with a different payload.",
                ),
              ),
            );
          }
          return;
        }
        try {
          const result = await runAutomationRequest(request);
          const response: PreviewAutomationResponse = {
            requestId: request.requestId,
            clientId: request.clientId,
            connectionId: request.connectionId,
            ok: true,
            ...(result !== undefined ? { result } : {}),
          };
          cache.store(request, response);
          await api.preview.automation.respond(response);
        } catch (cause) {
          const response = previewAutomationErrorResponse(request, cause);
          cache.store(request, response);
          await api.preview.automation.respond(response);
        }
      })();
    });
  }, [api, desktopPreview, runAutomationRequest, threadId]);

  const closePreview = useCallback(async () => {
    if (activeSession) {
      await stopPreviewRecording(activeSession.tabId).catch(() => undefined);
      await api.preview.close({ threadId, tabId: activeSession.tabId }).catch(() => undefined);
      await desktopPreview?.closeTab(activeSession.tabId).catch(() => undefined);
    }
    usePreviewPresentationStore.getState().remove(threadId);
    onClose();
  }, [activeSession, api, desktopPreview, onClose, stopPreviewRecording, threadId]);

  const pickElement = useCallback(async () => {
    if (!activeSession || !desktopPreview) return;
    setPicking(true);
    setError(null);
    try {
      const annotation = await desktopPreview.pickElement(activeSession.tabId);
      if (annotation) {
        await appendAnnotationToComposer(threadId, annotation);
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

  const selectedViewportPreset = activeSession
    ? (viewportPresetByTabId[activeSession.tabId] ??
      (requestedViewport
        ? (nearestPreviewViewportPreset(requestedViewport) ?? "custom")
        : "responsive"))
    : "responsive";

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

      <div className="flex h-9 shrink-0 items-center gap-1 border-b border-border/80 bg-card/35 px-2">
        <Select
          value={selectedViewportPreset}
          onValueChange={(value) => {
            if (!activeSession || value === null || value === "custom") return;
            const preset = PREVIEW_VIEWPORT_PRESETS.find((candidate) => candidate.id === value);
            if (!preset) return;
            const dimensions = preset.dimensions;
            setViewportPresetByTabId((current) => ({
              ...current,
              [activeSession.tabId]: preset.id,
            }));
            setRequestedViewportByTabId((current) => ({
              ...current,
              [activeSession.tabId]: dimensions,
            }));
            if (dimensions) {
              persistViewport(
                activeSession.tabId,
                clampPreviewViewport({ requested: dimensions, bounds: viewportBounds }),
                true,
              );
            } else {
              commitViewport(activeSession.tabId, null);
            }
          }}
        >
          <SelectTrigger size="xs" className="w-32">
            <SelectValue />
          </SelectTrigger>
          <SelectPopup>
            {PREVIEW_VIEWPORT_PRESETS.map((preset) => (
              <SelectItem key={preset.id} value={preset.id}>
                {preset.label}
              </SelectItem>
            ))}
            {selectedViewportPreset === "custom" ? (
              <SelectItem value="custom">Custom</SelectItem>
            ) : null}
          </SelectPopup>
        </Select>
        <Button
          size="icon-xs"
          variant="ghost"
          disabled={!activeSession || !requestedViewport}
          aria-label="Rotate viewport"
          onClick={() => {
            if (!activeSession || !requestedViewport) return;
            const orientation =
              requestedViewport.width > requestedViewport.height ? "portrait" : "landscape";
            const next = orientPreviewViewport(requestedViewport, orientation);
            setRequestedViewportByTabId((current) => ({
              ...current,
              [activeSession.tabId]: next,
            }));
            persistViewport(
              activeSession.tabId,
              clampPreviewViewport({ requested: next, bounds: viewportBounds }),
              true,
            );
          }}
        >
          <ScalingIcon />
        </Button>
        <Button
          size="icon-xs"
          variant="ghost"
          disabled={!activeSession || !requestedViewport}
          aria-label={
            viewportLinked ? "Unlock viewport aspect ratio" : "Lock viewport aspect ratio"
          }
          onClick={() => {
            if (!activeSession) return;
            const linked = !viewportLinked;
            setViewportLinkedByTabId((current) => ({
              ...current,
              [activeSession.tabId]: linked,
            }));
            setSessions((current) =>
              current.map((session) =>
                session.tabId === activeSession.tabId
                  ? { ...session, viewportLinked: linked }
                  : session,
              ),
            );
            void api.preview.reportStatus({
              threadId,
              tabId: activeSession.tabId,
              navStatus: activeSession.navStatus,
              canGoBack: activeSession.canGoBack,
              canGoForward: activeSession.canGoForward,
              colorScheme: activeSession.colorScheme,
              viewport: activeSession.viewport,
              viewportLinked: linked,
            });
          }}
        >
          {viewportLinked ? <LinkIcon /> : <UnlinkIcon />}
        </Button>
        <span className="min-w-20 text-[11px] tabular-nums text-muted-foreground">
          {activeViewport ? `${activeViewport.width} × ${activeViewport.height}` : "Fit panel"}
        </span>
        <Select
          value={activeSession?.colorScheme ?? "system"}
          disabled={recordingTabId === activeSession?.tabId}
          onValueChange={(value) => {
            if (!activeSession || (value !== "system" && value !== "light" && value !== "dark")) {
              return;
            }
            setSessions((current) =>
              current.map((session) =>
                session.tabId === activeSession.tabId
                  ? { ...session, colorScheme: value }
                  : session,
              ),
            );
            void desktopPreview
              .setColorScheme(activeSession.tabId, value)
              .catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)));
            void api.preview.reportStatus({
              threadId,
              tabId: activeSession.tabId,
              navStatus: activeSession.navStatus,
              canGoBack: activeSession.canGoBack,
              canGoForward: activeSession.canGoForward,
              colorScheme: value,
            });
          }}
        >
          <SelectTrigger size="xs" className="w-24" aria-label="Preview color scheme">
            <SelectValue />
          </SelectTrigger>
          <SelectPopup>
            <SelectItem value="system">System</SelectItem>
            <SelectItem value="light">Light</SelectItem>
            <SelectItem value="dark">Dark</SelectItem>
          </SelectPopup>
        </Select>
        <div className="flex-1" />
        <Button
          size="icon-xs"
          variant="ghost"
          disabled={!activeSession}
          aria-label="Capture screenshot"
          onClick={() => {
            if (!activeSession) return;
            void captureScreenshot(activeSession.tabId).catch((cause) =>
              setError(cause instanceof Error ? cause.message : String(cause)),
            );
          }}
        >
          <CameraIcon />
        </Button>
        {desktopPreview.recording ? (
          <Button
            size="icon-xs"
            variant={recordingTabId === activeSession?.tabId ? "destructive" : "ghost"}
            disabled={!activeSession}
            aria-label={
              recordingTabId === activeSession?.tabId ? "Stop recording" : "Record preview"
            }
            onClick={() => {
              if (!activeSession) return;
              const operation =
                recordingTabId === activeSession.tabId
                  ? stopPreviewRecording(activeSession.tabId)
                  : startPreviewRecording(activeSession.tabId);
              void operation.catch((cause) =>
                setError(cause instanceof Error ? cause.message : String(cause)),
              );
            }}
          >
            {recordingTabId === activeSession?.tabId ? <CircleStopIcon /> : <VideoIcon />}
          </Button>
        ) : null}
      </div>

      {error && (
        <div className="border-b border-destructive/20 bg-destructive/8 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      )}

      <div ref={viewportContainerRef} className="relative min-h-0 flex-1 overflow-auto bg-muted/20">
        {sessions.length > 0 && webviewConfig ? (
          <div className="flex min-h-full min-w-full items-center justify-center">
            {sessions.map((session) => {
              const isActive = session.tabId === activeSession?.tabId;
              const requested = requestedViewportByTabId[session.tabId] ?? null;
              const dimensions = requested
                ? clampPreviewViewport({ requested, bounds: viewportBounds })
                : null;
              return (
                <PreviewBrowserWebview
                  key={session.tabId}
                  session={session}
                  visible={isActive}
                  config={webviewConfig}
                  desktopPreview={desktopPreview}
                  dimensions={dimensions}
                  hiddenDimensions={requested ?? viewportBounds}
                  onStatus={reportWebviewStatus}
                />
              );
            })}
            {activeSession && activeViewport ? (
              <button
                type="button"
                aria-label="Resize preview viewport"
                className="absolute bottom-1 right-1 z-10 size-5 cursor-nwse-resize rounded-sm border border-border bg-background/90"
                onPointerDown={(event) => {
                  viewportDragRef.current = {
                    pointerId: event.pointerId,
                    tabId: activeSession.tabId,
                    startX: event.clientX,
                    startY: event.clientY,
                    width: activeViewport.width,
                    height: activeViewport.height,
                    linked: viewportLinked,
                  };
                  event.currentTarget.setPointerCapture(event.pointerId);
                }}
                onPointerMove={(event) => {
                  const drag = viewportDragRef.current;
                  if (!drag || drag.pointerId !== event.pointerId) return;
                  const next = resizePreviewViewport({
                    initial: { width: drag.width, height: drag.height },
                    delta: {
                      width: event.clientX - drag.startX,
                      height: event.clientY - drag.startY,
                    },
                    linked: drag.linked,
                    bounds: viewportBounds,
                  });
                  setRequestedViewportByTabId((current) => ({ ...current, [drag.tabId]: next }));
                  setViewportPresetByTabId((current) => ({ ...current, [drag.tabId]: "custom" }));
                }}
                onPointerUp={(event) => {
                  const drag = viewportDragRef.current;
                  if (!drag || drag.pointerId !== event.pointerId) return;
                  viewportDragRef.current = null;
                  event.currentTarget.releasePointerCapture(event.pointerId);
                  const finalDimensions = requestedViewportByTabId[drag.tabId];
                  if (finalDimensions) persistViewport(drag.tabId, finalDimensions, true);
                }}
                onPointerCancel={() => {
                  viewportDragRef.current = null;
                }}
              />
            ) : null}
          </div>
        ) : (
          <div className="flex h-full items-center justify-center">
            <Spinner className="size-5 text-muted-foreground" />
          </div>
        )}

        {!activeUrl && (
          <div className="absolute inset-0 overflow-y-auto bg-background p-4">
            <div className="mx-auto max-w-md space-y-3">
              {recentLocations.length > 0 ? (
                <div className="space-y-2">
                  <p className="text-sm font-medium text-foreground">Recent</p>
                  {recentLocations.map((location) => (
                    <button
                      key={location.url}
                      type="button"
                      className={cn(
                        "flex w-full items-center justify-between gap-3 rounded-md border border-border/80 bg-card/55 px-3 py-2 text-left",
                        "transition hover:border-border hover:bg-accent/50",
                      )}
                      onClick={() => void navigateTo(location.url)}
                    >
                      <span className="min-w-0">
                        <span className="block truncate text-sm font-medium">
                          {previewPresentationTitle(location.title, location.url)}
                        </span>
                        <span className="block truncate text-xs text-muted-foreground">
                          {location.url}
                        </span>
                      </span>
                      <Globe2Icon className="size-4 shrink-0 text-muted-foreground" />
                    </button>
                  ))}
                </div>
              ) : null}
              <div className="flex items-center justify-between pt-1">
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
