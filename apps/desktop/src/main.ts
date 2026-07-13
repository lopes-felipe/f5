import * as ChildProcess from "node:child_process";
import * as Crypto from "node:crypto";
import * as FS from "node:fs";
import * as OS from "node:os";
import * as Path from "node:path";

import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  nativeTheme,
  protocol,
  shell,
  session as electronSession,
  webContents as electronWebContents,
} from "electron";
import type { MenuItemConstructorOptions } from "electron";
import * as Effect from "effect/Effect";
import type {
  DesktopPreviewTabState,
  DesktopTheme,
  DesktopUpdateActionResult,
  DesktopUpdateState,
  PreviewAutomationClickInput,
  PreviewAutomationEvaluateInput,
  PreviewAutomationPressInput,
  PreviewAutomationScrollInput,
  PreviewAutomationSnapshot,
  PreviewAutomationStatus,
  PreviewAutomationTypeInput,
  PreviewAutomationWaitForInput,
  PreviewAnnotationPayload,
  PreviewAnnotationRect,
} from "@t3tools/contracts";
import { autoUpdater } from "electron-updater";

import type { ContextMenuItem } from "@t3tools/contracts";
import { NetService } from "@t3tools/shared/Net";
import { RotatingFileSink } from "@t3tools/shared/logging";
import { normalizePreviewUrl } from "@t3tools/shared/preview";
import { buildDesktopBackendEnv, resolveDesktopStateDirConfig } from "./backendEnv";
import { showDesktopConfirmDialog } from "./confirmDialog";
import { syncShellEnvironment } from "./syncShellEnvironment";
import { getAutoUpdateDisabledReason, shouldBroadcastDownloadProgress } from "./updateState";
import {
  createInitialDesktopUpdateState,
  reduceDesktopUpdateStateOnCheckFailure,
  reduceDesktopUpdateStateOnCheckStart,
  reduceDesktopUpdateStateOnDownloadComplete,
  reduceDesktopUpdateStateOnDownloadFailure,
  reduceDesktopUpdateStateOnDownloadProgress,
  reduceDesktopUpdateStateOnDownloadStart,
  reduceDesktopUpdateStateOnInstallFailure,
  reduceDesktopUpdateStateOnNoUpdate,
  reduceDesktopUpdateStateOnUpdateAvailable,
} from "./updateMachine";
import { isArm64HostRunningIntelBuild, resolveDesktopRuntimeInfo } from "./runtimeArch";
import { formatErrorMessage, isPreviewNavigationAbortError } from "./previewNavigationErrors";

syncShellEnvironment();

const PICK_FOLDER_CHANNEL = "desktop:pick-folder";
const CONFIRM_CHANNEL = "desktop:confirm";
const SET_THEME_CHANNEL = "desktop:set-theme";
const CONTEXT_MENU_CHANNEL = "desktop:context-menu";
const OPEN_EXTERNAL_CHANNEL = "desktop:open-external";
const MENU_ACTION_CHANNEL = "desktop:menu-action";
const UPDATE_STATE_CHANNEL = "desktop:update-state";
const UPDATE_GET_STATE_CHANNEL = "desktop:update-get-state";
const UPDATE_DOWNLOAD_CHANNEL = "desktop:update-download";
const UPDATE_INSTALL_CHANNEL = "desktop:update-install";
const PREVIEW_GET_CONFIG_CHANNEL = "desktop-preview:get-config";
const PREVIEW_CREATE_TAB_CHANNEL = "desktop-preview:create-tab";
const PREVIEW_CLOSE_TAB_CHANNEL = "desktop-preview:close-tab";
const PREVIEW_REGISTER_WEBVIEW_CHANNEL = "desktop-preview:register-webview";
const PREVIEW_NAVIGATE_CHANNEL = "desktop-preview:navigate";
const PREVIEW_GO_BACK_CHANNEL = "desktop-preview:go-back";
const PREVIEW_GO_FORWARD_CHANNEL = "desktop-preview:go-forward";
const PREVIEW_REFRESH_CHANNEL = "desktop-preview:refresh";
const PREVIEW_HARD_RELOAD_CHANNEL = "desktop-preview:hard-reload";
const PREVIEW_OPEN_DEVTOOLS_CHANNEL = "desktop-preview:open-devtools";
const PREVIEW_PICK_ELEMENT_CHANNEL = "desktop-preview:pick-element";
const PREVIEW_CANCEL_PICK_ELEMENT_CHANNEL = "desktop-preview:cancel-pick-element";
const PREVIEW_AUTOMATION_STATUS_CHANNEL = "desktop-preview:automation-status";
const PREVIEW_AUTOMATION_SNAPSHOT_CHANNEL = "desktop-preview:automation-snapshot";
const PREVIEW_AUTOMATION_CLICK_CHANNEL = "desktop-preview:automation-click";
const PREVIEW_AUTOMATION_TYPE_CHANNEL = "desktop-preview:automation-type";
const PREVIEW_AUTOMATION_PRESS_CHANNEL = "desktop-preview:automation-press";
const PREVIEW_AUTOMATION_SCROLL_CHANNEL = "desktop-preview:automation-scroll";
const PREVIEW_AUTOMATION_EVALUATE_CHANNEL = "desktop-preview:automation-evaluate";
const PREVIEW_AUTOMATION_WAIT_FOR_CHANNEL = "desktop-preview:automation-wait-for";
const PREVIEW_STATE_CHANNEL = "desktop-preview:state";
const STATE_DIR_CONFIG = resolveDesktopStateDirConfig(process.env);
const STATE_DIR = STATE_DIR_CONFIG.stateDir;
const DESKTOP_SCHEME = "t3";
const ROOT_DIR = Path.resolve(__dirname, "../../..");
const isDevelopment = Boolean(process.env.VITE_DEV_SERVER_URL);
const APP_DISPLAY_NAME = isDevelopment ? "F5 (Dev)" : "F5 (Alpha)";
const APP_USER_MODEL_ID = "com.t3tools.t3code";
const USER_DATA_DIR_NAME = isDevelopment ? "t3code-dev" : "t3code";
const LEGACY_USER_DATA_DIR_NAME = isDevelopment ? "T3 Code (Dev)" : "T3 Code (Alpha)";
const COMMIT_HASH_PATTERN = /^[0-9a-f]{7,40}$/i;
const COMMIT_HASH_DISPLAY_LENGTH = 12;
const LOG_DIR = Path.join(STATE_DIR, "logs");
const LOG_FILE_MAX_BYTES = 10 * 1024 * 1024;
const LOG_FILE_MAX_FILES = 10;
const APP_RUN_ID = Crypto.randomBytes(6).toString("hex");
const AUTO_UPDATE_STARTUP_DELAY_MS = 15_000;
const AUTO_UPDATE_POLL_INTERVAL_MS = 4 * 60 * 60 * 1000;
const DESKTOP_UPDATE_CHANNEL = "latest";
const DESKTOP_UPDATE_ALLOW_PRERELEASE = false;
const PREVIEW_WEBVIEW_PARTITION = "persist:f5-preview";
const PREVIEW_WEBVIEW_PREFERENCES = "contextIsolation=true,sandbox=true,nodeIntegration=false";
const PREVIEW_DEFAULT_ZOOM_FACTOR = 1;
const PREVIEW_CAPTURE_MAX_EDGE_PX = 1600;
const PREVIEW_CAPTURE_MAX_PIXELS = 2_000_000;
const PREVIEW_AUTOMATION_MAX_TEXT_LENGTH = 20_000;
const PREVIEW_AUTOMATION_MAX_ELEMENTS = 80;
const PREVIEW_AUTOMATION_MAX_EVALUATION_BYTES = 64_000;
const PREVIEW_AUTOMATION_EVALUATE_DEFAULT_TIMEOUT_MS = 15_000;
const PREVIEW_AUTOMATION_WAIT_INTERVAL_MS = 100;
const PREVIEW_AUTOMATION_PRINTABLE_KEY_PATTERN = /^[A-Za-z0-9]$/;
const PREVIEW_AUTOMATION_SUPPORTED_PUNCTUATION_KEYS: ReadonlySet<string> = new Set([
  "`",
  "-",
  "=",
  "[",
  "]",
  "\\",
  ";",
  "'",
  ",",
  ".",
  "/",
]);
const PREVIEW_AUTOMATION_SUPPORTED_NAMED_KEYS: ReadonlySet<string> = new Set([
  "Backspace",
  "Tab",
  "Enter",
  "Escape",
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "Delete",
  "Home",
  "End",
  "PageUp",
  "PageDown",
  "Space",
  "Insert",
  ...Array.from({ length: 24 }, (_, index) => `F${index + 1}`),
]);

type DesktopUpdateErrorContext = DesktopUpdateState["errorContext"];

let mainWindow: BrowserWindow | null = null;
let backendProcess: ChildProcess.ChildProcess | null = null;
let backendPort = 0;
let backendAuthToken = "";
let backendWsUrl = "";
let restartAttempt = 0;
let restartTimer: ReturnType<typeof setTimeout> | null = null;
let isQuitting = false;
let desktopProtocolRegistered = false;
let aboutCommitHashCache: string | null | undefined;
let desktopLogSink: RotatingFileSink | null = null;
let backendLogSink: RotatingFileSink | null = null;
let restoreStdIoCapture: (() => void) | null = null;

let destructiveMenuIconCache: Electron.NativeImage | null | undefined;
interface PreviewTabEntry {
  webContentsId: number | null;
  zoomFactor: number;
  removeListeners: Array<() => void>;
}

const previewTabs = new Map<string, PreviewTabEntry>();

const desktopRuntimeInfo = resolveDesktopRuntimeInfo({
  platform: process.platform,
  processArch: process.arch,
  runningUnderArm64Translation: app.runningUnderARM64Translation === true,
});
const initialUpdateState = (): DesktopUpdateState =>
  createInitialDesktopUpdateState(app.getVersion(), desktopRuntimeInfo);

function logTimestamp(): string {
  return new Date().toISOString();
}

function logScope(scope: string): string {
  return `${scope} run=${APP_RUN_ID}`;
}

function sanitizeLogValue(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function writeDesktopLogHeader(message: string): void {
  if (!desktopLogSink) return;
  desktopLogSink.write(`[${logTimestamp()}] [${logScope("desktop")}] ${message}\n`);
}

function writeBackendSessionBoundary(phase: "START" | "END", details: string): void {
  if (!backendLogSink) return;
  const normalizedDetails = sanitizeLogValue(details);
  backendLogSink.write(
    `[${logTimestamp()}] ---- APP SESSION ${phase} run=${APP_RUN_ID} ${normalizedDetails} ----\n`,
  );
}

function getSafeExternalUrl(rawUrl: unknown): string | null {
  if (typeof rawUrl !== "string" || rawUrl.length === 0) {
    return null;
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(rawUrl);
  } catch {
    return null;
  }

  if (parsedUrl.protocol !== "https:" && parsedUrl.protocol !== "http:") {
    return null;
  }

  return parsedUrl.toString();
}

function getSafePreviewUrl(rawUrl: unknown): string | null {
  if (typeof rawUrl !== "string" || rawUrl.length === 0) {
    return null;
  }

  try {
    return normalizePreviewUrl(rawUrl);
  } catch {
    return null;
  }
}

function getSafeTheme(rawTheme: unknown): DesktopTheme | null {
  if (rawTheme === "light" || rawTheme === "dark" || rawTheme === "system") {
    return rawTheme;
  }

  return null;
}

function lookupPreviewTabEntry(tabId: unknown): PreviewTabEntry | null {
  if (typeof tabId !== "string" || tabId.trim().length === 0) {
    return null;
  }
  return previewTabs.get(tabId) ?? null;
}

function ensurePreviewTabEntry(tabId: unknown): PreviewTabEntry | null {
  if (typeof tabId !== "string" || tabId.trim().length === 0) {
    return null;
  }
  let entry = lookupPreviewTabEntry(tabId);
  if (!entry) {
    entry = {
      webContentsId: null,
      zoomFactor: PREVIEW_DEFAULT_ZOOM_FACTOR,
      removeListeners: [],
    };
    previewTabs.set(tabId, entry);
  }
  return entry;
}

function getPreviewWebContents(tabId: unknown): Electron.WebContents | null {
  const entry = lookupPreviewTabEntry(tabId);
  if (!entry?.webContentsId) {
    return null;
  }
  const guest = electronWebContents.fromId(entry.webContentsId);
  if (!guest || guest.isDestroyed() || !isPreviewGuestWebContents(guest)) {
    return null;
  }
  return guest;
}

function previewStateFromWebContents(
  tabId: string,
  guest: Electron.WebContents | null,
): DesktopPreviewTabState {
  const entry = lookupPreviewTabEntry(tabId);
  const url = guest && !guest.isDestroyed() ? guest.getURL() : "";
  const title = guest && !guest.isDestroyed() ? guest.getTitle() : "";
  const isLoading = guest && !guest.isDestroyed() ? guest.isLoadingMainFrame() : false;
  return {
    tabId,
    webContentsId: guest && !guest.isDestroyed() ? guest.id : null,
    navStatus:
      url.length === 0 || url === "about:blank"
        ? { kind: "Idle" }
        : isLoading
          ? { kind: "Loading", url, title }
          : { kind: "Success", url, title },
    canGoBack: guest && !guest.isDestroyed() ? guest.canGoBack() : false,
    canGoForward: guest && !guest.isDestroyed() ? guest.canGoForward() : false,
    zoomFactor: entry?.zoomFactor ?? PREVIEW_DEFAULT_ZOOM_FACTOR,
    updatedAt: new Date().toISOString(),
  };
}

function isPreviewGuestWebContents(guest: Electron.WebContents): boolean {
  if (guest.isDestroyed() || guest.getType() !== "webview") {
    return false;
  }
  if (guest.session !== electronSession.fromPartition(PREVIEW_WEBVIEW_PARTITION)) {
    return false;
  }
  const hostWebContents = guest.hostWebContents;
  return Boolean(mainWindow && hostWebContents === mainWindow.webContents);
}

function emitPreviewState(tabId: string): void {
  const guest = getPreviewWebContents(tabId);
  const state = previewStateFromWebContents(tabId, guest);
  mainWindow?.webContents.send(PREVIEW_STATE_CHANNEL, tabId, state);
}

function registerPreviewWebContents(tabId: string, webContentsId: number): boolean {
  const guest = electronWebContents.fromId(webContentsId);
  if (!guest || guest.isDestroyed() || !isPreviewGuestWebContents(guest)) {
    return false;
  }
  const entry = ensurePreviewTabEntry(tabId);
  if (!entry) {
    return false;
  }
  if (entry.webContentsId === webContentsId) {
    emitPreviewState(tabId);
    return true;
  }
  for (const removeListener of entry.removeListeners) {
    removeListener();
  }
  entry.removeListeners = [];
  entry.webContentsId = webContentsId;
  entry.zoomFactor = guest.getZoomFactor();
  guest.setWindowOpenHandler(({ url }) => {
    const externalUrl = getSafeExternalUrl(url);
    if (externalUrl) {
      void shell.openExternal(externalUrl);
    }
    return { action: "deny" };
  });

  const onState = () => emitPreviewState(tabId);
  const onWillNavigate = (event: Electron.Event, url: string) => {
    const previewUrl = getSafePreviewUrl(url);
    if (previewUrl) {
      return;
    }
    const externalUrl = getSafeExternalUrl(url);
    if (externalUrl) {
      void shell.openExternal(externalUrl);
    }
    event.preventDefault();
  };
  const onDestroyed = () => {
    const current = previewTabs.get(tabId);
    if (current?.webContentsId === webContentsId) {
      current.webContentsId = null;
      emitPreviewState(tabId);
    }
  };

  guest.on("did-start-loading", onState);
  guest.on("did-stop-loading", onState);
  guest.on("did-navigate", onState);
  guest.on("did-navigate-in-page", onState);
  guest.on("page-title-updated", onState);
  guest.on("will-navigate", onWillNavigate);
  guest.on("destroyed", onDestroyed);
  entry.removeListeners.push(
    () => guest.off("did-start-loading", onState),
    () => guest.off("did-stop-loading", onState),
    () => guest.off("did-navigate", onState),
    () => guest.off("did-navigate-in-page", onState),
    () => guest.off("page-title-updated", onState),
    () => guest.off("will-navigate", onWillNavigate),
    () => guest.off("destroyed", onDestroyed),
  );
  emitPreviewState(tabId);
  return true;
}

function closePreviewTab(tabId: string): void {
  const entry = previewTabs.get(tabId);
  if (!entry) {
    return;
  }
  for (const removeListener of entry.removeListeners) {
    removeListener();
  }
  const guest = getPreviewWebContents(tabId);
  if (guest && !guest.isDestroyed()) {
    guest.close();
  }
  previewTabs.delete(tabId);
  mainWindow?.webContents.send(
    PREVIEW_STATE_CHANNEL,
    tabId,
    previewStateFromWebContents(tabId, null),
  );
}

function buildPreviewPickScript(): string {
  return String.raw`
(() => {
  if (window.__f5PreviewPickCancel) {
    window.__f5PreviewPickCancel();
  }

  const selectorFor = (element) => {
    if (!element || element.nodeType !== Node.ELEMENT_NODE) return null;
    if (element.id) return "#" + CSS.escape(element.id);
    const parts = [];
    let current = element;
    while (current && current.nodeType === Node.ELEMENT_NODE && current !== document.documentElement) {
      let part = current.localName;
      if (!part) break;
      const parent = current.parentElement;
      if (parent) {
        const siblings = Array.from(parent.children).filter((child) => child.localName === current.localName);
        if (siblings.length > 1) {
          part += ":nth-of-type(" + (siblings.indexOf(current) + 1) + ")";
        }
      }
      parts.unshift(part);
      current = parent;
    }
    return parts.length > 0 ? parts.join(" > ") : null;
  };

  const previewText = (value, limit) => String(value || "").replace(/\s+/g, " ").trim().slice(0, limit);

  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.style.cssText = "position:fixed;z-index:2147483647;pointer-events:none;border:2px solid #2563eb;background:rgba(37,99,235,.12);box-shadow:0 0 0 99999px rgba(15,23,42,.18);border-radius:4px;display:none;";
    const label = document.createElement("div");
    label.style.cssText = "position:fixed;z-index:2147483647;pointer-events:none;background:#2563eb;color:white;font:12px system-ui,sans-serif;padding:3px 6px;border-radius:4px;display:none;max-width:320px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;";
    document.documentElement.append(overlay, label);

    const cleanup = () => {
      window.__f5PreviewPickCancel = undefined;
      window.removeEventListener("mousemove", onMove, true);
      window.removeEventListener("click", onClick, true);
      window.removeEventListener("keydown", onKeyDown, true);
      overlay.remove();
      label.remove();
    };

    const finish = (value) => {
      cleanup();
      resolve(value);
    };

    const update = (target) => {
      if (!target || target === document.documentElement || target === document.body) {
        overlay.style.display = "none";
        label.style.display = "none";
        return;
      }
      const rect = target.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return;
      overlay.style.display = "block";
      overlay.style.left = rect.left + "px";
      overlay.style.top = rect.top + "px";
      overlay.style.width = rect.width + "px";
      overlay.style.height = rect.height + "px";
      label.style.display = "block";
      label.textContent = target.localName + (target.id ? "#" + target.id : "");
      label.style.left = Math.max(8, Math.min(window.innerWidth - 120, rect.left)) + "px";
      label.style.top = Math.max(8, rect.top - 28) + "px";
    };

    function onMove(event) {
      update(event.target);
    }

    function onClick(event) {
      event.preventDefault();
      event.stopPropagation();
      const target = event.target;
      if (!target || target.nodeType !== Node.ELEMENT_NODE) {
        finish(null);
        return;
      }
      const rect = target.getBoundingClientRect();
      const pageUrl = location.href;
      const pageTitle = document.title || null;
      finish({
        pageUrl,
        pageTitle,
        viewport: {
          width: Math.max(1, Math.floor(window.innerWidth || 1)),
          height: Math.max(1, Math.floor(window.innerHeight || 1))
        },
        rect: {
          x: Math.max(0, Math.floor(rect.x)),
          y: Math.max(0, Math.floor(rect.y)),
          width: Math.max(1, Math.ceil(rect.width)),
          height: Math.max(1, Math.ceil(rect.height))
        },
        element: {
          pageUrl,
          pageTitle,
          tagName: target.localName || "",
          selector: selectorFor(target),
          htmlPreview: previewText(target.outerHTML, 1600),
          textPreview: previewText(target.innerText || target.textContent, 500),
          pickedAt: new Date().toISOString()
        }
      });
    }

    function onKeyDown(event) {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        finish(null);
      }
    }

    window.__f5PreviewPickCancel = () => finish(null);
    window.addEventListener("mousemove", onMove, true);
    window.addEventListener("click", onClick, true);
    window.addEventListener("keydown", onKeyDown, true);
  });
})()
`;
}

function normalizePickRect(value: unknown): PreviewAnnotationRect | null {
  if (!value || typeof value !== "object") return null;
  const rect = value as Record<string, unknown>;
  const x = rect.x;
  const y = rect.y;
  const width = rect.width;
  const height = rect.height;
  if (
    typeof x !== "number" ||
    typeof y !== "number" ||
    typeof width !== "number" ||
    typeof height !== "number" ||
    !Number.isFinite(x) ||
    !Number.isFinite(y) ||
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    width <= 0 ||
    height <= 0
  ) {
    return null;
  }
  return {
    x: Math.max(0, Math.floor(x)),
    y: Math.max(0, Math.floor(y)),
    width: Math.max(1, Math.ceil(width)),
    height: Math.max(1, Math.ceil(height)),
  };
}

interface PreviewPickViewport {
  readonly width: number;
  readonly height: number;
}

function normalizePickViewport(value: unknown): PreviewPickViewport | null {
  if (!value || typeof value !== "object") return null;
  const viewport = value as Record<string, unknown>;
  const width = viewport.width;
  const height = viewport.height;
  if (
    typeof width !== "number" ||
    typeof height !== "number" ||
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    width <= 0 ||
    height <= 0
  ) {
    return null;
  }
  return {
    width: Math.max(1, Math.floor(width)),
    height: Math.max(1, Math.floor(height)),
  };
}

function clampPreviewCaptureRect(
  rect: PreviewAnnotationRect,
  viewport: PreviewPickViewport,
): PreviewAnnotationRect | null {
  const left = Math.max(0, Math.min(viewport.width, Math.floor(rect.x)));
  const top = Math.max(0, Math.min(viewport.height, Math.floor(rect.y)));
  const right = Math.max(left, Math.min(viewport.width, Math.ceil(rect.x + rect.width)));
  const bottom = Math.max(top, Math.min(viewport.height, Math.ceil(rect.y + rect.height)));
  let width = right - left;
  let height = bottom - top;
  if (width <= 0 || height <= 0) {
    return null;
  }
  if (width > PREVIEW_CAPTURE_MAX_EDGE_PX) {
    width = PREVIEW_CAPTURE_MAX_EDGE_PX;
  }
  if (height > PREVIEW_CAPTURE_MAX_EDGE_PX) {
    height = PREVIEW_CAPTURE_MAX_EDGE_PX;
  }
  const pixels = width * height;
  if (pixels > PREVIEW_CAPTURE_MAX_PIXELS) {
    const scale = Math.sqrt(PREVIEW_CAPTURE_MAX_PIXELS / pixels);
    width = Math.max(1, Math.floor(width * scale));
    height = Math.max(1, Math.floor(height * scale));
  }
  return { x: left, y: top, width, height };
}

async function capturePreviewAnnotationScreenshot(
  guest: Electron.WebContents,
  rect: PreviewAnnotationRect,
): Promise<PreviewAnnotationPayload["screenshot"]> {
  const image = await guest.capturePage(rect);
  const size = image.getSize();
  return {
    dataUrl: image.toDataURL(),
    width: size.width,
    height: size.height,
    cropRect: rect,
  };
}

function isPickedElementResult(value: unknown): value is {
  readonly pageUrl: string;
  readonly pageTitle: string | null;
  readonly rect: PreviewAnnotationRect;
  readonly viewport: PreviewPickViewport;
  readonly element: PreviewAnnotationPayload["elements"][number]["element"];
} {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.pageUrl !== "string") return false;
  if (typeof candidate.pageTitle !== "string" && candidate.pageTitle !== null) return false;
  if (normalizePickRect(candidate.rect) === null) return false;
  if (normalizePickViewport(candidate.viewport) === null) return false;
  const element = candidate.element;
  if (!element || typeof element !== "object") return false;
  const elementRecord = element as Record<string, unknown>;
  return (
    typeof elementRecord.pageUrl === "string" &&
    (typeof elementRecord.pageTitle === "string" || elementRecord.pageTitle === null) &&
    typeof elementRecord.tagName === "string" &&
    (typeof elementRecord.selector === "string" || elementRecord.selector === null) &&
    typeof elementRecord.htmlPreview === "string" &&
    typeof elementRecord.textPreview === "string" &&
    typeof elementRecord.pickedAt === "string"
  );
}

async function pickPreviewElement(tabId: string): Promise<PreviewAnnotationPayload | null> {
  const guest = getPreviewWebContents(tabId);
  if (!guest) {
    throw new Error("Preview webview is not attached.");
  }
  const rawResult = await guest.executeJavaScript(buildPreviewPickScript(), true);
  if (!isPickedElementResult(rawResult)) {
    return null;
  }
  const rect = normalizePickRect(rawResult.rect);
  const viewport = normalizePickViewport(rawResult.viewport);
  if (!rect || !viewport) {
    return null;
  }
  const captureRect = clampPreviewCaptureRect(rect, viewport);
  let screenshot: PreviewAnnotationPayload["screenshot"] = null;
  if (captureRect) {
    try {
      screenshot = await capturePreviewAnnotationScreenshot(guest, captureRect);
    } catch {
      screenshot = null;
    }
  }
  const createdAt = new Date().toISOString();
  return {
    id: `preview-annotation-${Crypto.randomUUID()}`,
    pageUrl: rawResult.pageUrl,
    pageTitle: rawResult.pageTitle,
    comment: "",
    elements: [
      {
        id: `element-${Crypto.randomUUID()}`,
        element: rawResult.element,
        rect,
      },
    ],
    screenshot,
    createdAt,
  };
}

function requirePreviewWebContents(tabId: unknown): Electron.WebContents {
  const guest = getPreviewWebContents(tabId);
  if (!guest) {
    throw new Error("Preview webview is not attached.");
  }
  return guest;
}

function previewAutomationStatus(tabId: string): PreviewAutomationStatus {
  const guest = getPreviewWebContents(tabId);
  if (!guest) {
    const entry = lookupPreviewTabEntry(tabId);
    return {
      available: false,
      visible: false,
      tabId: entry ? tabId : null,
      url: null,
      title: null,
      loading: false,
    };
  }
  return {
    available: true,
    visible: true,
    tabId,
    url: guest.getURL() || null,
    title: guest.getTitle() || null,
    loading: guest.isLoading(),
  };
}

function automationSelectorResolverScript(input: {
  readonly selector?: string | undefined;
  readonly locator?: string | undefined;
}): string {
  return String.raw`
const targetFromSelectorOrLocator = () => {
  const selector = ${JSON.stringify(input.selector ?? null)};
  const locator = ${JSON.stringify(input.locator ?? null)};
  const visible = (element) => {
    if (!element || element.nodeType !== Node.ELEMENT_NODE) return false;
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.visibility !== "hidden" && style.display !== "none" && rect.width > 0 && rect.height > 0;
  };
  if (selector) return document.querySelector(selector);
  if (!locator) return document.activeElement;
  if (locator.startsWith("text=")) {
    const text = locator.slice("text=".length).replace(/^["']|["']$/g, "");
    return Array.from(document.querySelectorAll("body *")).find((element) => visible(element) && (element.innerText || element.textContent || "").includes(text)) || null;
  }
  const roleMatch = /^role=([a-zA-Z0-9_-]+)(?:\[name=(["'])(.*?)\2\])?$/.exec(locator);
  if (roleMatch) {
    const role = roleMatch[1].toLowerCase();
    const expectedName = roleMatch[3] || "";
    const implicitSelector = role === "button"
      ? "button,input[type='button'],input[type='submit'],input[type='reset']"
      : role === "link"
        ? "a[href]"
        : role === "textbox"
          ? "input:not([type]),input[type='text'],input[type='search'],input[type='email'],input[type='url'],textarea,[contenteditable='true']"
          : "";
    const explicitRoleSelector = "[role=" + JSON.stringify(role) + "]";
    const candidates = Array.from(document.querySelectorAll([explicitRoleSelector, implicitSelector].filter(Boolean).join(",")));
    return candidates.find((element) => {
      if (!visible(element)) return false;
      if (!expectedName) return true;
      const name = element.getAttribute("aria-label") || element.getAttribute("name") || element.innerText || element.textContent || element.value || "";
      return String(name).includes(expectedName);
    }) || null;
  }
  try {
    return document.querySelector(locator);
  } catch {
    return null;
  }
};
`;
}

async function executePreviewJavaScript<T>(
  guest: Electron.WebContents,
  script: string,
): Promise<T> {
  return (await guest.executeJavaScript(script, true)) as T;
}

function waitPreviewAutomationPoll(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, PREVIEW_AUTOMATION_WAIT_INTERVAL_MS));
}

function buildPreviewAutomationSnapshotScript(): string {
  return String.raw`
(() => {
  const selectorFor = (element) => {
    if (!element || element.nodeType !== Node.ELEMENT_NODE) return "";
    if (element.id) return "#" + CSS.escape(element.id);
    for (const attribute of ["data-testid", "name", "aria-label"]) {
      const value = element.getAttribute(attribute);
      if (value) return element.tagName.toLowerCase() + "[" + attribute + "=" + JSON.stringify(value) + "]";
    }
    const parts = [];
    let current = element;
    while (current && current.nodeType === Node.ELEMENT_NODE && parts.length < 8) {
      const parent = current.parentElement;
      const siblings = parent
        ? Array.from(parent.children).filter((child) => child.tagName === current.tagName)
        : [];
      const base = current.tagName.toLowerCase();
      parts.unshift(siblings.length > 1 ? base + ":nth-of-type(" + (siblings.indexOf(current) + 1) + ")" : base);
      current = parent;
    }
    return parts.join(" > ");
  };
  const visible = (element) => {
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.visibility !== "hidden" && style.display !== "none" && rect.width > 0 && rect.height > 0;
  };
  const elements = Array.from(document.querySelectorAll("a[href],button,input,textarea,select,[role],[tabindex],[contenteditable='true']"))
    .filter(visible)
    .slice(0, ${PREVIEW_AUTOMATION_MAX_ELEMENTS})
    .map((element) => {
      const rect = element.getBoundingClientRect();
      return {
        tag: element.tagName.toLowerCase(),
        role: element.getAttribute("role"),
        name: element.getAttribute("aria-label") || element.getAttribute("name") || element.innerText || element.textContent || element.value || "",
        selector: selectorFor(element),
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height
      };
    });
  return {
    url: location.href,
    title: document.title,
    loading: document.readyState !== "complete",
    visibleText: (document.body?.innerText || "").slice(0, ${PREVIEW_AUTOMATION_MAX_TEXT_LENGTH}),
    interactiveElements: elements,
    accessibilityTree: null,
    consoleEntries: [],
    networkEntries: [],
    actionTimeline: []
  };
})()
`;
}

async function previewAutomationSnapshot(tabId: string): Promise<PreviewAutomationSnapshot> {
  const guest = requirePreviewWebContents(tabId);
  const page = await executePreviewJavaScript<Omit<PreviewAutomationSnapshot, "screenshot">>(
    guest,
    buildPreviewAutomationSnapshotScript(),
  );
  const viewport = normalizePickViewport(
    await executePreviewJavaScript<unknown>(
      guest,
      "(() => ({ width: window.innerWidth, height: window.innerHeight }))()",
    ),
  );
  const rect = viewport
    ? clampPreviewCaptureRect(
        { x: 0, y: 0, width: viewport.width, height: viewport.height },
        viewport,
      )
    : null;
  const image = await guest.capturePage(rect ?? undefined);
  const size = image.getSize();
  return {
    ...page,
    screenshot: {
      mimeType: "image/png",
      data: image.toPNG().toString("base64"),
      width: size.width,
      height: size.height,
    },
  };
}

async function resolveAutomationClickPoint(
  guest: Electron.WebContents,
  input: PreviewAutomationClickInput,
): Promise<{ x: number; y: number }> {
  if (typeof input.x === "number" && typeof input.y === "number") {
    return { x: input.x, y: input.y };
  }
  const timeoutMs = input.timeoutMs ?? 15_000;
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const result = await executePreviewJavaScript<
      { ok: true; x: number; y: number } | { ok: false; message: string }
    >(
      guest,
      `(() => {
        ${automationSelectorResolverScript(input)}
        const element = targetFromSelectorOrLocator();
        if (!element) return { ok: false, message: "No element matched the requested preview target." };
        element.scrollIntoView({ block: "center", inline: "center" });
        const rect = element.getBoundingClientRect();
        return { ok: true, x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
      })()`,
    );
    if (result.ok) {
      return { x: result.x, y: result.y };
    }
    if (Date.now() >= deadline) {
      throw new Error(result.message);
    }
    await waitPreviewAutomationPoll();
  }
}

async function previewAutomationClick(
  tabId: string,
  input: PreviewAutomationClickInput,
): Promise<void> {
  const guest = requirePreviewWebContents(tabId);
  const point = await resolveAutomationClickPoint(guest, input);
  guest.sendInputEvent({ type: "mouseMove", x: Math.round(point.x), y: Math.round(point.y) });
  guest.sendInputEvent({
    type: "mouseDown",
    x: Math.round(point.x),
    y: Math.round(point.y),
    button: "left",
    clickCount: 1,
  });
  guest.sendInputEvent({
    type: "mouseUp",
    x: Math.round(point.x),
    y: Math.round(point.y),
    button: "left",
    clickCount: 1,
  });
}

async function previewAutomationType(
  tabId: string,
  input: PreviewAutomationTypeInput,
): Promise<void> {
  const guest = requirePreviewWebContents(tabId);
  const timeoutMs = input.timeoutMs ?? 15_000;
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const focused = await executePreviewJavaScript<boolean>(
      guest,
      `(() => {
        ${automationSelectorResolverScript(input)}
        const element = targetFromSelectorOrLocator();
        if (!element) return false;
        window.__f5PreviewAutomationTypeTarget = element;
        element.focus();
        if (${input.clear === true ? "true" : "false"}) {
          if ("value" in element) element.value = "";
          else if (element.isContentEditable) element.textContent = "";
          element.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "deleteContentBackward" }));
        }
        return true;
      })()`,
    );
    if (focused) {
      break;
    }
    if (Date.now() >= deadline) {
      throw new Error("No element matched the requested preview target.");
    }
    await waitPreviewAutomationPoll();
  }
  await guest.insertText(input.text);
  await executePreviewJavaScript(
    guest,
    `(() => {
      const storedTarget = window.__f5PreviewAutomationTypeTarget;
      delete window.__f5PreviewAutomationTypeTarget;
      const element = storedTarget?.isConnected ? storedTarget : document.activeElement;
      element?.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: ${JSON.stringify(input.text)} }));
      element?.dispatchEvent(new Event("change", { bubbles: true }));
    })()`,
  );
}

function electronModifiers(
  modifiers: PreviewAutomationPressInput["modifiers"],
): NonNullable<Electron.InputEvent["modifiers"]> {
  return (modifiers ?? []).map((modifier) => {
    switch (modifier) {
      case "Alt":
        return "alt";
      case "Control":
        return "control";
      case "Meta":
        return "meta";
      case "Shift":
        return "shift";
      default: {
        const exhaustive: never = modifier;
        throw new Error(`Unsupported preview automation modifier: ${String(exhaustive)}`);
      }
    }
  });
}

function previewAutomationKeyCode(key: string): string {
  const normalized = key.trim();
  if (
    PREVIEW_AUTOMATION_PRINTABLE_KEY_PATTERN.test(normalized) ||
    PREVIEW_AUTOMATION_SUPPORTED_PUNCTUATION_KEYS.has(normalized) ||
    PREVIEW_AUTOMATION_SUPPORTED_NAMED_KEYS.has(normalized)
  ) {
    return normalized;
  }
  throw new Error(`Unsupported preview automation key: ${key}`);
}

async function previewAutomationPress(
  tabId: string,
  input: PreviewAutomationPressInput,
): Promise<void> {
  const guest = requirePreviewWebContents(tabId);
  const modifiers = electronModifiers(input.modifiers);
  const keyCode = previewAutomationKeyCode(input.key);
  guest.sendInputEvent({ type: "keyDown", keyCode, modifiers });
  guest.sendInputEvent({ type: "keyUp", keyCode, modifiers });
}

async function previewAutomationScroll(
  tabId: string,
  input: PreviewAutomationScrollInput,
): Promise<void> {
  const guest = requirePreviewWebContents(tabId);
  const result = await executePreviewJavaScript<boolean>(
    guest,
    `(() => {
      ${automationSelectorResolverScript(input)}
      const target = ${input.selector || input.locator ? "targetFromSelectorOrLocator()" : "window"};
      if (!target) return false;
      target.scrollBy({ left: ${input.deltaX ?? 0}, top: ${input.deltaY ?? 0}, behavior: "instant" });
      return true;
    })()`,
  );
  if (!result) {
    throw new Error("No element matched the requested preview target.");
  }
}

async function previewAutomationEvaluate(
  tabId: string,
  input: PreviewAutomationEvaluateInput,
): Promise<unknown> {
  const guest = requirePreviewWebContents(tabId);
  const timeoutMs = input.timeoutMs ?? PREVIEW_AUTOMATION_EVALUATE_DEFAULT_TIMEOUT_MS;
  const result = await executePreviewJavaScript(
    guest,
    `(() => {
      const expression = ${JSON.stringify(input.expression)};
      const awaitPromise = ${input.awaitPromise === false ? "false" : "true"};
      const timeoutMs = ${JSON.stringify(timeoutMs)};
      let timeoutId;
      const timeout = new Promise((_, reject) => {
        timeoutId = setTimeout(
          () => reject(new Error("Preview evaluation timed out after " + timeoutMs + "ms.")),
          timeoutMs
        );
      });
      const evaluate = async () => {
        const value = (0, eval)(expression);
        return awaitPromise ? await value : value;
      };
      return Promise.race([evaluate(), timeout]).finally(() => clearTimeout(timeoutId));
    })()`,
  );
  const serialized = JSON.stringify(result);
  if (
    serialized &&
    Buffer.byteLength(serialized, "utf8") > PREVIEW_AUTOMATION_MAX_EVALUATION_BYTES
  ) {
    throw new Error(`Evaluation result exceeds ${PREVIEW_AUTOMATION_MAX_EVALUATION_BYTES} bytes.`);
  }
  return result;
}

async function previewAutomationWaitFor(
  tabId: string,
  input: PreviewAutomationWaitForInput,
): Promise<void> {
  const guest = requirePreviewWebContents(tabId);
  const deadline = Date.now() + (input.timeoutMs ?? 15_000);
  const checkScript = `(() => {
    ${automationSelectorResolverScript(input)}
    const selectorMatched = ${input.selector || input.locator ? "targetFromSelectorOrLocator() !== null" : "true"};
    const textMatched = ${input.text ? `(document.body?.innerText || "").includes(${JSON.stringify(input.text)})` : "true"};
    const urlMatched = ${input.urlIncludes ? `location.href.includes(${JSON.stringify(input.urlIncludes)})` : "true"};
    return selectorMatched && textMatched && urlMatched;
  })()`;
  while (Date.now() < deadline) {
    if (await executePreviewJavaScript<boolean>(guest, checkScript)) {
      return;
    }
    await waitPreviewAutomationPoll();
  }
  throw new Error(`Preview wait timed out after ${input.timeoutMs ?? 15_000}ms.`);
}

function writeDesktopStreamChunk(
  streamName: "stdout" | "stderr",
  chunk: unknown,
  encoding: BufferEncoding | undefined,
): void {
  if (!desktopLogSink) return;
  const buffer = Buffer.isBuffer(chunk)
    ? chunk
    : Buffer.from(String(chunk), typeof chunk === "string" ? encoding : undefined);
  desktopLogSink.write(`[${logTimestamp()}] [${logScope(streamName)}] `);
  desktopLogSink.write(buffer);
  if (buffer.length === 0 || buffer[buffer.length - 1] !== 0x0a) {
    desktopLogSink.write("\n");
  }
}

function installStdIoCapture(): void {
  if (!app.isPackaged || desktopLogSink === null || restoreStdIoCapture !== null) {
    return;
  }

  const originalStdoutWrite = process.stdout.write.bind(process.stdout);
  const originalStderrWrite = process.stderr.write.bind(process.stderr);

  const patchWrite =
    (streamName: "stdout" | "stderr", originalWrite: typeof process.stdout.write) =>
    (
      chunk: string | Uint8Array,
      encodingOrCallback?: BufferEncoding | ((error?: Error | null) => void),
      callback?: (error?: Error | null) => void,
    ): boolean => {
      const encoding = typeof encodingOrCallback === "string" ? encodingOrCallback : undefined;
      writeDesktopStreamChunk(streamName, chunk, encoding);
      if (typeof encodingOrCallback === "function") {
        return originalWrite(chunk, encodingOrCallback);
      }
      if (callback !== undefined) {
        return originalWrite(chunk, encoding, callback);
      }
      if (encoding !== undefined) {
        return originalWrite(chunk, encoding);
      }
      return originalWrite(chunk);
    };

  process.stdout.write = patchWrite("stdout", originalStdoutWrite);
  process.stderr.write = patchWrite("stderr", originalStderrWrite);

  restoreStdIoCapture = () => {
    process.stdout.write = originalStdoutWrite;
    process.stderr.write = originalStderrWrite;
    restoreStdIoCapture = null;
  };
}

function initializePackagedLogging(): void {
  if (!app.isPackaged) return;
  try {
    desktopLogSink = new RotatingFileSink({
      filePath: Path.join(LOG_DIR, "desktop-main.log"),
      maxBytes: LOG_FILE_MAX_BYTES,
      maxFiles: LOG_FILE_MAX_FILES,
    });
    backendLogSink = new RotatingFileSink({
      filePath: Path.join(LOG_DIR, "server-child.log"),
      maxBytes: LOG_FILE_MAX_BYTES,
      maxFiles: LOG_FILE_MAX_FILES,
    });
    installStdIoCapture();
    writeDesktopLogHeader(`runtime log capture enabled logDir=${LOG_DIR}`);
  } catch (error) {
    // Logging setup should never block app startup.
    console.error("[desktop] failed to initialize packaged logging", error);
  }
}

function captureBackendOutput(child: ChildProcess.ChildProcess): void {
  if (!app.isPackaged || backendLogSink === null) return;
  const writeChunk = (chunk: unknown): void => {
    if (!backendLogSink) return;
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), "utf8");
    backendLogSink.write(buffer);
  };
  child.stdout?.on("data", writeChunk);
  child.stderr?.on("data", writeChunk);
}

initializePackagedLogging();

function getDestructiveMenuIcon(): Electron.NativeImage | undefined {
  if (process.platform !== "darwin") return undefined;
  if (destructiveMenuIconCache !== undefined) {
    return destructiveMenuIconCache ?? undefined;
  }
  try {
    const icon = nativeImage.createFromNamedImage("trash").resize({
      width: 14,
      height: 14,
    });
    if (icon.isEmpty()) {
      destructiveMenuIconCache = null;
      return undefined;
    }
    icon.setTemplateImage(true);
    destructiveMenuIconCache = icon;
    return icon;
  } catch {
    destructiveMenuIconCache = null;
    return undefined;
  }
}
let updatePollTimer: ReturnType<typeof setInterval> | null = null;
let updateStartupTimer: ReturnType<typeof setTimeout> | null = null;
let updateCheckInFlight = false;
let updateDownloadInFlight = false;
let updaterConfigured = false;
let updateState: DesktopUpdateState = initialUpdateState();

function resolveUpdaterErrorContext(): DesktopUpdateErrorContext {
  if (updateDownloadInFlight) return "download";
  if (updateCheckInFlight) return "check";
  return updateState.errorContext;
}

protocol.registerSchemesAsPrivileged([
  {
    scheme: DESKTOP_SCHEME,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
    },
  },
]);

function resolveAppRoot(): string {
  if (!app.isPackaged) {
    return ROOT_DIR;
  }
  return app.getAppPath();
}

/** Read the baked-in app-update.yml config (if applicable). */
function readAppUpdateYml(): Record<string, string> | null {
  try {
    // electron-updater reads from process.resourcesPath in packaged builds,
    // or dev-app-update.yml via app.getAppPath() in dev.
    const ymlPath = app.isPackaged
      ? Path.join(process.resourcesPath, "app-update.yml")
      : Path.join(app.getAppPath(), "dev-app-update.yml");
    const raw = FS.readFileSync(ymlPath, "utf-8");
    // The YAML is simple key-value pairs — avoid pulling in a YAML parser by
    // doing a line-based parse (fields: provider, owner, repo, releaseType, …).
    const entries: Record<string, string> = {};
    for (const line of raw.split("\n")) {
      const match = line.match(/^(\w+):\s*(.+)$/);
      if (match?.[1] && match[2]) entries[match[1]] = match[2].trim();
    }
    return entries.provider ? entries : null;
  } catch {
    return null;
  }
}

function normalizeCommitHash(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  if (!COMMIT_HASH_PATTERN.test(trimmed)) {
    return null;
  }
  return trimmed.slice(0, COMMIT_HASH_DISPLAY_LENGTH).toLowerCase();
}

function resolveEmbeddedCommitHash(): string | null {
  const packageJsonPath = Path.join(resolveAppRoot(), "package.json");
  if (!FS.existsSync(packageJsonPath)) {
    return null;
  }

  try {
    const raw = FS.readFileSync(packageJsonPath, "utf8");
    const parsed = JSON.parse(raw) as { t3codeCommitHash?: unknown };
    return normalizeCommitHash(parsed.t3codeCommitHash);
  } catch {
    return null;
  }
}

function resolveAboutCommitHash(): string | null {
  if (aboutCommitHashCache !== undefined) {
    return aboutCommitHashCache;
  }

  const envCommitHash = normalizeCommitHash(process.env.T3CODE_COMMIT_HASH);
  if (envCommitHash) {
    aboutCommitHashCache = envCommitHash;
    return aboutCommitHashCache;
  }

  // Only packaged builds are required to expose commit metadata.
  if (!app.isPackaged) {
    aboutCommitHashCache = null;
    return aboutCommitHashCache;
  }

  aboutCommitHashCache = resolveEmbeddedCommitHash();

  return aboutCommitHashCache;
}

function resolveBackendEntry(): string {
  return Path.join(resolveAppRoot(), "apps/server/dist/index.mjs");
}

function resolveBackendCwd(): string {
  if (!app.isPackaged) {
    return resolveAppRoot();
  }
  return OS.homedir();
}

function resolveDesktopStaticDir(): string | null {
  const appRoot = resolveAppRoot();
  const candidates = [
    Path.join(appRoot, "apps/server/dist/client"),
    Path.join(appRoot, "apps/web/dist"),
  ];

  for (const candidate of candidates) {
    if (FS.existsSync(Path.join(candidate, "index.html"))) {
      return candidate;
    }
  }

  return null;
}

function resolveDesktopStaticPath(staticRoot: string, requestUrl: string): string {
  const url = new URL(requestUrl);
  const rawPath = decodeURIComponent(url.pathname);
  const normalizedPath = Path.posix.normalize(rawPath).replace(/^\/+/, "");
  if (normalizedPath.includes("..")) {
    return Path.join(staticRoot, "index.html");
  }

  const requestedPath = normalizedPath.length > 0 ? normalizedPath : "index.html";
  const resolvedPath = Path.join(staticRoot, requestedPath);

  if (Path.extname(resolvedPath)) {
    return resolvedPath;
  }

  const nestedIndex = Path.join(resolvedPath, "index.html");
  if (FS.existsSync(nestedIndex)) {
    return nestedIndex;
  }

  return Path.join(staticRoot, "index.html");
}

function isStaticAssetRequest(requestUrl: string): boolean {
  try {
    const url = new URL(requestUrl);
    return Path.extname(url.pathname).length > 0;
  } catch {
    return false;
  }
}

function handleFatalStartupError(stage: string, error: unknown): void {
  const message = formatErrorMessage(error);
  const detail =
    error instanceof Error && typeof error.stack === "string" ? `\n${error.stack}` : "";
  writeDesktopLogHeader(`fatal startup error stage=${stage} message=${message}`);
  console.error(`[desktop] fatal startup error (${stage})`, error);
  if (!isQuitting) {
    isQuitting = true;
    dialog.showErrorBox("F5 failed to start", `Stage: ${stage}\n${message}${detail}`);
  }
  stopBackend();
  restoreStdIoCapture?.();
  app.quit();
}

function registerDesktopProtocol(): void {
  if (isDevelopment || desktopProtocolRegistered) return;

  const staticRoot = resolveDesktopStaticDir();
  if (!staticRoot) {
    throw new Error(
      "Desktop static bundle missing. Build apps/server (with bundled client) first.",
    );
  }

  const staticRootResolved = Path.resolve(staticRoot);
  const staticRootPrefix = `${staticRootResolved}${Path.sep}`;
  const fallbackIndex = Path.join(staticRootResolved, "index.html");

  protocol.registerFileProtocol(DESKTOP_SCHEME, (request, callback) => {
    try {
      const candidate = resolveDesktopStaticPath(staticRootResolved, request.url);
      const resolvedCandidate = Path.resolve(candidate);
      const isInRoot =
        resolvedCandidate === fallbackIndex || resolvedCandidate.startsWith(staticRootPrefix);
      const isAssetRequest = isStaticAssetRequest(request.url);

      if (!isInRoot || !FS.existsSync(resolvedCandidate)) {
        if (isAssetRequest) {
          callback({ error: -6 });
          return;
        }
        callback({ path: fallbackIndex });
        return;
      }

      callback({ path: resolvedCandidate });
    } catch {
      callback({ path: fallbackIndex });
    }
  });

  desktopProtocolRegistered = true;
}

function dispatchMenuAction(action: string): void {
  const existingWindow =
    BrowserWindow.getFocusedWindow() ?? mainWindow ?? BrowserWindow.getAllWindows()[0];
  const targetWindow = existingWindow ?? createWindow();
  if (!existingWindow) {
    mainWindow = targetWindow;
  }

  const send = () => {
    if (targetWindow.isDestroyed()) return;
    targetWindow.webContents.send(MENU_ACTION_CHANNEL, action);
    if (!targetWindow.isVisible()) {
      targetWindow.show();
    }
    targetWindow.focus();
  };

  if (targetWindow.webContents.isLoadingMainFrame()) {
    targetWindow.webContents.once("did-finish-load", send);
    return;
  }

  send();
}

function handleCheckForUpdatesMenuClick(): void {
  const disabledReason = getAutoUpdateDisabledReason({
    isDevelopment,
    isPackaged: app.isPackaged,
    platform: process.platform,
    appImage: process.env.APPIMAGE,
    disabledByEnv: process.env.T3CODE_DISABLE_AUTO_UPDATE === "1",
  });
  if (disabledReason) {
    console.info("[desktop-updater] Manual update check requested, but updates are disabled.");
    void dialog.showMessageBox({
      type: "info",
      title: "Updates unavailable",
      message: "Automatic updates are not available right now.",
      detail: disabledReason,
      buttons: ["OK"],
    });
    return;
  }

  if (!BrowserWindow.getAllWindows().length) {
    mainWindow = createWindow();
  }
  void checkForUpdatesFromMenu();
}

async function checkForUpdatesFromMenu(): Promise<void> {
  await checkForUpdates("menu");

  if (updateState.status === "up-to-date") {
    void dialog.showMessageBox({
      type: "info",
      title: "You're up to date!",
      message: `F5 ${updateState.currentVersion} is currently the newest version available.`,
      buttons: ["OK"],
    });
  } else if (updateState.status === "error") {
    void dialog.showMessageBox({
      type: "warning",
      title: "Update check failed",
      message: "Could not check for updates.",
      detail: updateState.message ?? "An unknown error occurred. Please try again later.",
      buttons: ["OK"],
    });
  }
}

function configureApplicationMenu(): void {
  const template: MenuItemConstructorOptions[] = [];

  if (process.platform === "darwin") {
    template.push({
      label: app.name,
      submenu: [
        { role: "about" },
        {
          label: "Check for Updates...",
          click: () => handleCheckForUpdatesMenuClick(),
        },
        { type: "separator" },
        {
          label: "Settings...",
          accelerator: "CmdOrCtrl+,",
          click: () => dispatchMenuAction("open-settings"),
        },
        { type: "separator" },
        { role: "services" },
        { type: "separator" },
        { role: "hide" },
        { role: "hideOthers" },
        { role: "unhide" },
        { type: "separator" },
        { role: "quit" },
      ],
    });
  }

  template.push(
    {
      label: "File",
      submenu: [
        ...(process.platform === "darwin"
          ? []
          : [
              {
                label: "Settings...",
                accelerator: "CmdOrCtrl+,",
                click: () => dispatchMenuAction("open-settings"),
              },
              { type: "separator" as const },
            ]),
        { role: process.platform === "darwin" ? "close" : "quit" },
      ],
    },
    { role: "editMenu" },
    {
      label: "View",
      submenu: [
        { role: "reload" },
        { role: "forceReload" },
        { role: "toggleDevTools" },
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn", accelerator: "CmdOrCtrl+=" },
        { role: "zoomIn", accelerator: "CmdOrCtrl+Plus", visible: false },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },
    { role: "windowMenu" },
    {
      role: "help",
      submenu: [
        {
          label: "Check for Updates...",
          click: () => handleCheckForUpdatesMenuClick(),
        },
      ],
    },
  );

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function resolveResourcePath(fileName: string): string | null {
  const candidates = [
    Path.join(__dirname, "../resources", fileName),
    Path.join(__dirname, "../prod-resources", fileName),
    Path.join(process.resourcesPath, "resources", fileName),
    Path.join(process.resourcesPath, fileName),
  ];

  for (const candidate of candidates) {
    if (FS.existsSync(candidate)) {
      return candidate;
    }
  }

  return null;
}

function resolveIconPath(ext: "ico" | "icns" | "png"): string | null {
  return resolveResourcePath(`icon.${ext}`);
}

/**
 * Resolve the Electron userData directory path.
 *
 * Electron derives the default userData path from `productName` in
 * package.json, which currently produces directories with spaces and
 * parentheses (e.g. `~/.config/T3 Code (Alpha)` on Linux). This is
 * unfriendly for shell usage and violates Linux naming conventions.
 *
 * We override it to a clean lowercase name (`t3code`). If the legacy
 * directory already exists we keep using it so existing users don't
 * lose their Chromium profile data (localStorage, cookies, sessions).
 */
function resolveUserDataPath(): string {
  const appDataBase =
    process.platform === "win32"
      ? process.env.APPDATA || Path.join(OS.homedir(), "AppData", "Roaming")
      : process.platform === "darwin"
        ? Path.join(OS.homedir(), "Library", "Application Support")
        : process.env.XDG_CONFIG_HOME || Path.join(OS.homedir(), ".config");

  const legacyPath = Path.join(appDataBase, LEGACY_USER_DATA_DIR_NAME);
  if (FS.existsSync(legacyPath)) {
    return legacyPath;
  }

  return Path.join(appDataBase, USER_DATA_DIR_NAME);
}

function configureAppIdentity(): void {
  app.setName(APP_DISPLAY_NAME);
  const commitHash = resolveAboutCommitHash();
  app.setAboutPanelOptions({
    applicationName: APP_DISPLAY_NAME,
    applicationVersion: app.getVersion(),
    version: commitHash ?? "unknown",
  });

  if (process.platform === "win32") {
    app.setAppUserModelId(APP_USER_MODEL_ID);
  }

  if (process.platform === "darwin" && app.dock) {
    const iconPath = resolveIconPath("png");
    if (iconPath) {
      app.dock.setIcon(iconPath);
    }
  }
}

function clearUpdatePollTimer(): void {
  if (updateStartupTimer) {
    clearTimeout(updateStartupTimer);
    updateStartupTimer = null;
  }
  if (updatePollTimer) {
    clearInterval(updatePollTimer);
    updatePollTimer = null;
  }
}

function emitUpdateState(): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (window.isDestroyed()) continue;
    window.webContents.send(UPDATE_STATE_CHANNEL, updateState);
  }
}

function setUpdateState(patch: Partial<DesktopUpdateState>): void {
  updateState = { ...updateState, ...patch };
  emitUpdateState();
}

function shouldEnableAutoUpdates(): boolean {
  return (
    getAutoUpdateDisabledReason({
      isDevelopment,
      isPackaged: app.isPackaged,
      platform: process.platform,
      appImage: process.env.APPIMAGE,
      disabledByEnv: process.env.T3CODE_DISABLE_AUTO_UPDATE === "1",
    }) === null
  );
}

async function checkForUpdates(reason: string): Promise<void> {
  if (isQuitting || !updaterConfigured || updateCheckInFlight) return;
  if (updateState.status === "downloading" || updateState.status === "downloaded") {
    console.info(
      `[desktop-updater] Skipping update check (${reason}) while status=${updateState.status}.`,
    );
    return;
  }
  updateCheckInFlight = true;
  setUpdateState(reduceDesktopUpdateStateOnCheckStart(updateState, new Date().toISOString()));
  console.info(`[desktop-updater] Checking for updates (${reason})...`);

  try {
    await autoUpdater.checkForUpdates();
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    setUpdateState(
      reduceDesktopUpdateStateOnCheckFailure(updateState, message, new Date().toISOString()),
    );
    console.error(`[desktop-updater] Failed to check for updates: ${message}`);
  } finally {
    updateCheckInFlight = false;
  }
}

async function downloadAvailableUpdate(): Promise<{ accepted: boolean; completed: boolean }> {
  if (!updaterConfigured || updateDownloadInFlight || updateState.status !== "available") {
    return { accepted: false, completed: false };
  }
  updateDownloadInFlight = true;
  setUpdateState(reduceDesktopUpdateStateOnDownloadStart(updateState));
  autoUpdater.disableDifferentialDownload = isArm64HostRunningIntelBuild(desktopRuntimeInfo);
  console.info("[desktop-updater] Downloading update...");

  try {
    await autoUpdater.downloadUpdate();
    return { accepted: true, completed: true };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    setUpdateState(reduceDesktopUpdateStateOnDownloadFailure(updateState, message));
    console.error(`[desktop-updater] Failed to download update: ${message}`);
    return { accepted: true, completed: false };
  } finally {
    updateDownloadInFlight = false;
  }
}

async function installDownloadedUpdate(): Promise<{ accepted: boolean; completed: boolean }> {
  if (isQuitting || !updaterConfigured || updateState.status !== "downloaded") {
    return { accepted: false, completed: false };
  }

  isQuitting = true;
  clearUpdatePollTimer();
  try {
    await stopBackendAndWaitForExit();
    autoUpdater.quitAndInstall();
    return { accepted: true, completed: true };
  } catch (error: unknown) {
    const message = formatErrorMessage(error);
    isQuitting = false;
    setUpdateState(reduceDesktopUpdateStateOnInstallFailure(updateState, message));
    console.error(`[desktop-updater] Failed to install update: ${message}`);
    return { accepted: true, completed: false };
  }
}

function configureAutoUpdater(): void {
  const enabled = shouldEnableAutoUpdates();
  setUpdateState({
    ...createInitialDesktopUpdateState(app.getVersion(), desktopRuntimeInfo),
    enabled,
    status: enabled ? "idle" : "disabled",
  });
  if (!enabled) {
    return;
  }
  updaterConfigured = true;

  const githubToken =
    process.env.T3CODE_DESKTOP_UPDATE_GITHUB_TOKEN?.trim() || process.env.GH_TOKEN?.trim() || "";
  if (githubToken) {
    // When a token is provided, re-configure the feed with `private: true` so
    // electron-updater uses the GitHub API (api.github.com) instead of the
    // public Atom feed (github.com/…/releases.atom) which rejects Bearer auth.
    const appUpdateYml = readAppUpdateYml();
    if (appUpdateYml?.provider === "github") {
      autoUpdater.setFeedURL({
        ...appUpdateYml,
        provider: "github" as const,
        private: true,
        token: githubToken,
      });
    }
  }

  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;
  // Keep alpha branding, but force all installs onto the stable update track.
  autoUpdater.channel = DESKTOP_UPDATE_CHANNEL;
  autoUpdater.allowPrerelease = DESKTOP_UPDATE_ALLOW_PRERELEASE;
  autoUpdater.allowDowngrade = false;
  autoUpdater.disableDifferentialDownload = isArm64HostRunningIntelBuild(desktopRuntimeInfo);
  let lastLoggedDownloadMilestone = -1;

  if (isArm64HostRunningIntelBuild(desktopRuntimeInfo)) {
    console.info(
      "[desktop-updater] Apple Silicon host detected while running Intel build; updates will switch to arm64 packages.",
    );
  }

  autoUpdater.on("checking-for-update", () => {
    console.info("[desktop-updater] Looking for updates...");
  });
  autoUpdater.on("update-available", (info) => {
    setUpdateState(
      reduceDesktopUpdateStateOnUpdateAvailable(
        updateState,
        info.version,
        new Date().toISOString(),
      ),
    );
    lastLoggedDownloadMilestone = -1;
    console.info(`[desktop-updater] Update available: ${info.version}`);
  });
  autoUpdater.on("update-not-available", () => {
    setUpdateState(reduceDesktopUpdateStateOnNoUpdate(updateState, new Date().toISOString()));
    lastLoggedDownloadMilestone = -1;
    console.info("[desktop-updater] No updates available.");
  });
  autoUpdater.on("error", (error) => {
    const message = formatErrorMessage(error);
    if (!updateCheckInFlight && !updateDownloadInFlight) {
      setUpdateState({
        status: "error",
        message,
        checkedAt: new Date().toISOString(),
        downloadPercent: null,
        errorContext: resolveUpdaterErrorContext(),
        canRetry: updateState.availableVersion !== null || updateState.downloadedVersion !== null,
      });
    }
    console.error(`[desktop-updater] Updater error: ${message}`);
  });
  autoUpdater.on("download-progress", (progress) => {
    const percent = Math.floor(progress.percent);
    if (
      shouldBroadcastDownloadProgress(updateState, progress.percent) ||
      updateState.message !== null
    ) {
      setUpdateState(reduceDesktopUpdateStateOnDownloadProgress(updateState, progress.percent));
    }
    const milestone = percent - (percent % 10);
    if (milestone > lastLoggedDownloadMilestone) {
      lastLoggedDownloadMilestone = milestone;
      console.info(`[desktop-updater] Download progress: ${percent}%`);
    }
  });
  autoUpdater.on("update-downloaded", (info) => {
    setUpdateState(reduceDesktopUpdateStateOnDownloadComplete(updateState, info.version));
    console.info(`[desktop-updater] Update downloaded: ${info.version}`);
  });

  clearUpdatePollTimer();

  updateStartupTimer = setTimeout(() => {
    updateStartupTimer = null;
    void checkForUpdates("startup");
  }, AUTO_UPDATE_STARTUP_DELAY_MS);
  updateStartupTimer.unref();

  updatePollTimer = setInterval(() => {
    void checkForUpdates("poll");
  }, AUTO_UPDATE_POLL_INTERVAL_MS);
  updatePollTimer.unref();
}
function backendEnv(): NodeJS.ProcessEnv {
  return buildDesktopBackendEnv(process.env, {
    backendPort,
    stateDir: STATE_DIR,
    stateDirSource: STATE_DIR_CONFIG.source,
    authToken: backendAuthToken,
  });
}

function scheduleBackendRestart(reason: string): void {
  if (isQuitting || restartTimer) return;

  const delayMs = Math.min(500 * 2 ** restartAttempt, 10_000);
  restartAttempt += 1;
  console.error(`[desktop] backend exited unexpectedly (${reason}); restarting in ${delayMs}ms`);

  restartTimer = setTimeout(() => {
    restartTimer = null;
    startBackend();
  }, delayMs);
}

function startBackend(): void {
  if (isQuitting || backendProcess) return;

  const backendEntry = resolveBackendEntry();
  if (!FS.existsSync(backendEntry)) {
    scheduleBackendRestart(`missing server entry at ${backendEntry}`);
    return;
  }

  const captureBackendLogs = app.isPackaged && backendLogSink !== null;
  const child = ChildProcess.spawn(process.execPath, [backendEntry], {
    cwd: resolveBackendCwd(),
    // In Electron main, process.execPath points to the Electron binary.
    // Run the child in Node mode so this backend process does not become a GUI app instance.
    env: {
      ...backendEnv(),
      ELECTRON_RUN_AS_NODE: "1",
    },
    stdio: captureBackendLogs ? ["ignore", "pipe", "pipe"] : "inherit",
  });
  backendProcess = child;
  let backendSessionClosed = false;
  const closeBackendSession = (details: string) => {
    if (backendSessionClosed) return;
    backendSessionClosed = true;
    writeBackendSessionBoundary("END", details);
  };
  writeBackendSessionBoundary(
    "START",
    `pid=${child.pid ?? "unknown"} port=${backendPort} cwd=${resolveBackendCwd()}`,
  );
  captureBackendOutput(child);

  child.once("spawn", () => {
    restartAttempt = 0;
  });

  child.on("error", (error) => {
    if (backendProcess === child) {
      backendProcess = null;
    }
    closeBackendSession(`pid=${child.pid ?? "unknown"} error=${error.message}`);
    scheduleBackendRestart(error.message);
  });

  child.on("exit", (code, signal) => {
    if (backendProcess === child) {
      backendProcess = null;
    }
    closeBackendSession(
      `pid=${child.pid ?? "unknown"} code=${code ?? "null"} signal=${signal ?? "null"}`,
    );
    if (isQuitting) return;
    const reason = `code=${code ?? "null"} signal=${signal ?? "null"}`;
    scheduleBackendRestart(reason);
  });
}

function stopBackend(): void {
  if (restartTimer) {
    clearTimeout(restartTimer);
    restartTimer = null;
  }

  const child = backendProcess;
  backendProcess = null;
  if (!child) return;

  if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGTERM");
    setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
      }
    }, 2_000).unref();
  }
}

async function stopBackendAndWaitForExit(timeoutMs = 5_000): Promise<void> {
  if (restartTimer) {
    clearTimeout(restartTimer);
    restartTimer = null;
  }

  const child = backendProcess;
  backendProcess = null;
  if (!child) return;
  const backendChild = child;
  if (backendChild.exitCode !== null || backendChild.signalCode !== null) return;

  await new Promise<void>((resolve) => {
    let settled = false;
    let forceKillTimer: ReturnType<typeof setTimeout> | null = null;
    let exitTimeoutTimer: ReturnType<typeof setTimeout> | null = null;

    function settle(): void {
      if (settled) return;
      settled = true;
      backendChild.off("exit", onExit);
      if (forceKillTimer) {
        clearTimeout(forceKillTimer);
      }
      if (exitTimeoutTimer) {
        clearTimeout(exitTimeoutTimer);
      }
      resolve();
    }

    function onExit(): void {
      settle();
    }

    backendChild.once("exit", onExit);
    backendChild.kill("SIGTERM");

    forceKillTimer = setTimeout(() => {
      if (backendChild.exitCode === null && backendChild.signalCode === null) {
        backendChild.kill("SIGKILL");
      }
    }, 2_000);
    forceKillTimer.unref();

    exitTimeoutTimer = setTimeout(() => {
      settle();
    }, timeoutMs);
    exitTimeoutTimer.unref();
  });
}

function registerIpcHandlers(): void {
  ipcMain.removeHandler(PICK_FOLDER_CHANNEL);
  ipcMain.handle(PICK_FOLDER_CHANNEL, async () => {
    const owner = BrowserWindow.getFocusedWindow() ?? mainWindow;
    const result = owner
      ? await dialog.showOpenDialog(owner, {
          properties: ["openDirectory", "createDirectory"],
        })
      : await dialog.showOpenDialog({
          properties: ["openDirectory", "createDirectory"],
        });
    if (result.canceled) return null;
    return result.filePaths[0] ?? null;
  });

  ipcMain.removeHandler(CONFIRM_CHANNEL);
  ipcMain.handle(CONFIRM_CHANNEL, async (_event, message: unknown) => {
    if (typeof message !== "string") {
      return false;
    }

    const owner = BrowserWindow.getFocusedWindow() ?? mainWindow;
    return showDesktopConfirmDialog(message, owner);
  });

  ipcMain.removeHandler(SET_THEME_CHANNEL);
  ipcMain.handle(SET_THEME_CHANNEL, async (_event, rawTheme: unknown) => {
    const theme = getSafeTheme(rawTheme);
    if (!theme) {
      return;
    }

    nativeTheme.themeSource = theme;
  });

  ipcMain.removeHandler(CONTEXT_MENU_CHANNEL);
  ipcMain.handle(
    CONTEXT_MENU_CHANNEL,
    async (_event, items: ContextMenuItem[], position?: { x: number; y: number }) => {
      const normalizedItems = items
        .filter((item) => typeof item.id === "string" && typeof item.label === "string")
        .map((item) => ({
          id: item.id,
          label: item.label,
          destructive: item.destructive === true,
        }));
      if (normalizedItems.length === 0) {
        return null;
      }

      const popupPosition =
        position &&
        Number.isFinite(position.x) &&
        Number.isFinite(position.y) &&
        position.x >= 0 &&
        position.y >= 0
          ? {
              x: Math.floor(position.x),
              y: Math.floor(position.y),
            }
          : null;

      const window = BrowserWindow.getFocusedWindow() ?? mainWindow;
      if (!window) return null;

      return new Promise<string | null>((resolve) => {
        const template: MenuItemConstructorOptions[] = [];
        let hasInsertedDestructiveSeparator = false;
        for (const item of normalizedItems) {
          if (item.destructive && !hasInsertedDestructiveSeparator && template.length > 0) {
            template.push({ type: "separator" });
            hasInsertedDestructiveSeparator = true;
          }
          const itemOption: MenuItemConstructorOptions = {
            label: item.label,
            click: () => resolve(item.id),
          };
          if (item.destructive) {
            const destructiveIcon = getDestructiveMenuIcon();
            if (destructiveIcon) {
              itemOption.icon = destructiveIcon;
            }
          }
          template.push(itemOption);
        }

        const menu = Menu.buildFromTemplate(template);
        menu.popup({
          window,
          ...popupPosition,
          callback: () => resolve(null),
        });
      });
    },
  );

  ipcMain.removeHandler(OPEN_EXTERNAL_CHANNEL);
  ipcMain.handle(OPEN_EXTERNAL_CHANNEL, async (_event, rawUrl: unknown) => {
    const externalUrl = getSafeExternalUrl(rawUrl);
    if (!externalUrl) {
      return false;
    }

    try {
      await shell.openExternal(externalUrl);
      return true;
    } catch {
      return false;
    }
  });

  ipcMain.removeHandler(UPDATE_GET_STATE_CHANNEL);
  ipcMain.handle(UPDATE_GET_STATE_CHANNEL, async () => updateState);

  ipcMain.removeHandler(UPDATE_DOWNLOAD_CHANNEL);
  ipcMain.handle(UPDATE_DOWNLOAD_CHANNEL, async () => {
    const result = await downloadAvailableUpdate();
    return {
      accepted: result.accepted,
      completed: result.completed,
      state: updateState,
    } satisfies DesktopUpdateActionResult;
  });

  ipcMain.removeHandler(UPDATE_INSTALL_CHANNEL);
  ipcMain.handle(UPDATE_INSTALL_CHANNEL, async () => {
    if (isQuitting) {
      return {
        accepted: false,
        completed: false,
        state: updateState,
      } satisfies DesktopUpdateActionResult;
    }
    const result = await installDownloadedUpdate();
    return {
      accepted: result.accepted,
      completed: result.completed,
      state: updateState,
    } satisfies DesktopUpdateActionResult;
  });

  ipcMain.removeHandler(PREVIEW_GET_CONFIG_CHANNEL);
  ipcMain.handle(PREVIEW_GET_CONFIG_CHANNEL, async () => ({
    partition: PREVIEW_WEBVIEW_PARTITION,
    webPreferences: PREVIEW_WEBVIEW_PREFERENCES,
  }));

  ipcMain.removeHandler(PREVIEW_CREATE_TAB_CHANNEL);
  ipcMain.handle(PREVIEW_CREATE_TAB_CHANNEL, async (_event, tabId: unknown) => {
    return ensurePreviewTabEntry(tabId) !== null;
  });

  ipcMain.removeHandler(PREVIEW_CLOSE_TAB_CHANNEL);
  ipcMain.handle(PREVIEW_CLOSE_TAB_CHANNEL, async (_event, tabId: unknown) => {
    if (typeof tabId !== "string") return;
    closePreviewTab(tabId);
  });

  ipcMain.removeHandler(PREVIEW_REGISTER_WEBVIEW_CHANNEL);
  ipcMain.handle(
    PREVIEW_REGISTER_WEBVIEW_CHANNEL,
    async (_event, tabId: unknown, webContentsId: unknown) => {
      if (
        typeof tabId !== "string" ||
        tabId.trim().length === 0 ||
        typeof webContentsId !== "number" ||
        !Number.isInteger(webContentsId) ||
        webContentsId <= 0
      ) {
        return false;
      }
      return registerPreviewWebContents(tabId, webContentsId);
    },
  );

  ipcMain.removeHandler(PREVIEW_NAVIGATE_CHANNEL);
  ipcMain.handle(PREVIEW_NAVIGATE_CHANNEL, async (_event, tabId: unknown, rawUrl: unknown) => {
    const guest = getPreviewWebContents(tabId);
    const url = getSafePreviewUrl(rawUrl);
    if (!guest || !url) {
      throw new Error("Preview navigation target is invalid.");
    }
    try {
      await guest.loadURL(url);
    } catch (error) {
      if (isPreviewNavigationAbortError(error)) {
        return;
      }
      throw error;
    }
  });

  ipcMain.removeHandler(PREVIEW_GO_BACK_CHANNEL);
  ipcMain.handle(PREVIEW_GO_BACK_CHANNEL, async (_event, tabId: unknown) => {
    const guest = getPreviewWebContents(tabId);
    if (guest?.canGoBack()) guest.goBack();
  });

  ipcMain.removeHandler(PREVIEW_GO_FORWARD_CHANNEL);
  ipcMain.handle(PREVIEW_GO_FORWARD_CHANNEL, async (_event, tabId: unknown) => {
    const guest = getPreviewWebContents(tabId);
    if (guest?.canGoForward()) guest.goForward();
  });

  ipcMain.removeHandler(PREVIEW_REFRESH_CHANNEL);
  ipcMain.handle(PREVIEW_REFRESH_CHANNEL, async (_event, tabId: unknown) => {
    getPreviewWebContents(tabId)?.reload();
  });

  ipcMain.removeHandler(PREVIEW_HARD_RELOAD_CHANNEL);
  ipcMain.handle(PREVIEW_HARD_RELOAD_CHANNEL, async (_event, tabId: unknown) => {
    getPreviewWebContents(tabId)?.reloadIgnoringCache();
  });

  ipcMain.removeHandler(PREVIEW_OPEN_DEVTOOLS_CHANNEL);
  ipcMain.handle(PREVIEW_OPEN_DEVTOOLS_CHANNEL, async (_event, tabId: unknown) => {
    getPreviewWebContents(tabId)?.openDevTools({ mode: "detach" });
  });

  ipcMain.removeHandler(PREVIEW_PICK_ELEMENT_CHANNEL);
  ipcMain.handle(PREVIEW_PICK_ELEMENT_CHANNEL, async (_event, tabId: unknown) => {
    if (typeof tabId !== "string" || tabId.trim().length === 0) {
      throw new Error("Preview tab id is invalid.");
    }
    return pickPreviewElement(tabId);
  });

  ipcMain.removeHandler(PREVIEW_CANCEL_PICK_ELEMENT_CHANNEL);
  ipcMain.handle(PREVIEW_CANCEL_PICK_ELEMENT_CHANNEL, async (_event, tabId: unknown) => {
    const guest = getPreviewWebContents(tabId);
    if (!guest) return;
    await guest.executeJavaScript("window.__f5PreviewPickCancel?.()", true).catch(() => null);
  });

  ipcMain.removeHandler(PREVIEW_AUTOMATION_STATUS_CHANNEL);
  ipcMain.handle(PREVIEW_AUTOMATION_STATUS_CHANNEL, async (_event, tabId: unknown) => {
    if (typeof tabId !== "string" || tabId.trim().length === 0) {
      throw new Error("Preview tab id is invalid.");
    }
    return previewAutomationStatus(tabId);
  });

  ipcMain.removeHandler(PREVIEW_AUTOMATION_SNAPSHOT_CHANNEL);
  ipcMain.handle(PREVIEW_AUTOMATION_SNAPSHOT_CHANNEL, async (_event, tabId: unknown) => {
    if (typeof tabId !== "string" || tabId.trim().length === 0) {
      throw new Error("Preview tab id is invalid.");
    }
    return previewAutomationSnapshot(tabId);
  });

  ipcMain.removeHandler(PREVIEW_AUTOMATION_CLICK_CHANNEL);
  ipcMain.handle(
    PREVIEW_AUTOMATION_CLICK_CHANNEL,
    async (_event, tabId: unknown, input: unknown) => {
      if (typeof tabId !== "string" || tabId.trim().length === 0) {
        throw new Error("Preview tab id is invalid.");
      }
      await previewAutomationClick(tabId, input as PreviewAutomationClickInput);
    },
  );

  ipcMain.removeHandler(PREVIEW_AUTOMATION_TYPE_CHANNEL);
  ipcMain.handle(
    PREVIEW_AUTOMATION_TYPE_CHANNEL,
    async (_event, tabId: unknown, input: unknown) => {
      if (typeof tabId !== "string" || tabId.trim().length === 0) {
        throw new Error("Preview tab id is invalid.");
      }
      await previewAutomationType(tabId, input as PreviewAutomationTypeInput);
    },
  );

  ipcMain.removeHandler(PREVIEW_AUTOMATION_PRESS_CHANNEL);
  ipcMain.handle(
    PREVIEW_AUTOMATION_PRESS_CHANNEL,
    async (_event, tabId: unknown, input: unknown) => {
      if (typeof tabId !== "string" || tabId.trim().length === 0) {
        throw new Error("Preview tab id is invalid.");
      }
      await previewAutomationPress(tabId, input as PreviewAutomationPressInput);
    },
  );

  ipcMain.removeHandler(PREVIEW_AUTOMATION_SCROLL_CHANNEL);
  ipcMain.handle(
    PREVIEW_AUTOMATION_SCROLL_CHANNEL,
    async (_event, tabId: unknown, input: unknown) => {
      if (typeof tabId !== "string" || tabId.trim().length === 0) {
        throw new Error("Preview tab id is invalid.");
      }
      await previewAutomationScroll(tabId, input as PreviewAutomationScrollInput);
    },
  );

  ipcMain.removeHandler(PREVIEW_AUTOMATION_EVALUATE_CHANNEL);
  ipcMain.handle(
    PREVIEW_AUTOMATION_EVALUATE_CHANNEL,
    async (_event, tabId: unknown, input: unknown) => {
      if (typeof tabId !== "string" || tabId.trim().length === 0) {
        throw new Error("Preview tab id is invalid.");
      }
      return previewAutomationEvaluate(tabId, input as PreviewAutomationEvaluateInput);
    },
  );

  ipcMain.removeHandler(PREVIEW_AUTOMATION_WAIT_FOR_CHANNEL);
  ipcMain.handle(
    PREVIEW_AUTOMATION_WAIT_FOR_CHANNEL,
    async (_event, tabId: unknown, input: unknown) => {
      if (typeof tabId !== "string" || tabId.trim().length === 0) {
        throw new Error("Preview tab id is invalid.");
      }
      await previewAutomationWaitFor(tabId, input as PreviewAutomationWaitForInput);
    },
  );
}

function getIconOption(): { icon: string } | Record<string, never> {
  if (process.platform === "darwin") return {}; // macOS uses .icns from app bundle
  const ext = process.platform === "win32" ? "ico" : "png";
  const iconPath = resolveIconPath(ext);
  return iconPath ? { icon: iconPath } : {};
}

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1100,
    height: 780,
    minWidth: 840,
    minHeight: 620,
    show: false,
    autoHideMenuBar: true,
    ...getIconOption(),
    title: APP_DISPLAY_NAME,
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 16, y: 18 },
    webPreferences: {
      preload: Path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: true,
    },
  });

  window.webContents.on("will-attach-webview", (event, webPreferences, params) => {
    const partition = typeof params.partition === "string" ? params.partition : "";
    if (partition !== PREVIEW_WEBVIEW_PARTITION) {
      event.preventDefault();
      return;
    }
    const src = typeof params.src === "string" ? params.src : "";
    if (
      params.allowpopups === "true" ||
      (src.length > 0 && src !== "about:blank" && !getSafePreviewUrl(src))
    ) {
      event.preventDefault();
      return;
    }
    webPreferences.sandbox = true;
    webPreferences.nodeIntegration = false;
    webPreferences.nodeIntegrationInSubFrames = false;
    webPreferences.contextIsolation = true;
    delete webPreferences.preload;
  });

  window.webContents.on("context-menu", (event, params) => {
    event.preventDefault();

    const menuTemplate: MenuItemConstructorOptions[] = [];

    if (params.misspelledWord) {
      for (const suggestion of params.dictionarySuggestions.slice(0, 5)) {
        menuTemplate.push({
          label: suggestion,
          click: () => window.webContents.replaceMisspelling(suggestion),
        });
      }
      if (params.dictionarySuggestions.length === 0) {
        menuTemplate.push({ label: "No suggestions", enabled: false });
      }
      menuTemplate.push({ type: "separator" });
    }

    menuTemplate.push(
      { role: "cut", enabled: params.editFlags.canCut },
      { role: "copy", enabled: params.editFlags.canCopy },
      { role: "paste", enabled: params.editFlags.canPaste },
      { role: "selectAll", enabled: params.editFlags.canSelectAll },
    );

    Menu.buildFromTemplate(menuTemplate).popup({ window });
  });

  window.webContents.setWindowOpenHandler(({ url }) => {
    const externalUrl = getSafeExternalUrl(url);
    if (externalUrl) {
      void shell.openExternal(externalUrl);
    }
    return { action: "deny" };
  });

  window.on("page-title-updated", (event) => {
    event.preventDefault();
    window.setTitle(APP_DISPLAY_NAME);
  });
  window.webContents.on("did-finish-load", () => {
    window.setTitle(APP_DISPLAY_NAME);
    emitUpdateState();
  });
  window.once("ready-to-show", () => {
    window.show();
  });

  if (isDevelopment) {
    void window.loadURL(process.env.VITE_DEV_SERVER_URL as string);
    window.webContents.openDevTools({ mode: "detach" });
  } else {
    void window.loadURL(`${DESKTOP_SCHEME}://app/index.html`);
  }

  window.on("closed", () => {
    if (mainWindow === window) {
      mainWindow = null;
    }
  });

  return window;
}

// Override Electron's userData path before the `ready` event so that
// Chromium session data uses a filesystem-friendly directory name.
// Must be called synchronously at the top level — before `app.whenReady()`.
app.setPath("userData", resolveUserDataPath());

configureAppIdentity();

async function bootstrap(): Promise<void> {
  writeDesktopLogHeader("bootstrap start");
  backendPort = await Effect.service(NetService).pipe(
    Effect.flatMap((net) => net.reserveLoopbackPort()),
    Effect.provide(NetService.layer),
    Effect.runPromise,
  );
  writeDesktopLogHeader(`reserved backend port via NetService port=${backendPort}`);
  backendAuthToken = Crypto.randomBytes(24).toString("hex");
  backendWsUrl = `ws://127.0.0.1:${backendPort}/?token=${encodeURIComponent(backendAuthToken)}`;
  process.env.T3CODE_DESKTOP_WS_URL = backendWsUrl;
  writeDesktopLogHeader(`bootstrap resolved websocket endpoint=ws://127.0.0.1:${backendPort}`);

  registerIpcHandlers();
  writeDesktopLogHeader("bootstrap ipc handlers registered");
  startBackend();
  writeDesktopLogHeader("bootstrap backend start requested");
  mainWindow = createWindow();
  writeDesktopLogHeader("bootstrap main window created");
}

app.on("before-quit", () => {
  isQuitting = true;
  writeDesktopLogHeader("before-quit received");
  clearUpdatePollTimer();
  stopBackend();
  restoreStdIoCapture?.();
});

app
  .whenReady()
  .then(() => {
    writeDesktopLogHeader("app ready");
    configureAppIdentity();
    configureApplicationMenu();
    registerDesktopProtocol();
    configureAutoUpdater();
    void bootstrap().catch((error) => {
      handleFatalStartupError("bootstrap", error);
    });

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        mainWindow = createWindow();
      }
    });
  })
  .catch((error) => {
    handleFatalStartupError("whenReady", error);
  });

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

if (process.platform !== "win32") {
  process.on("SIGINT", () => {
    if (isQuitting) return;
    isQuitting = true;
    writeDesktopLogHeader("SIGINT received");
    clearUpdatePollTimer();
    stopBackend();
    restoreStdIoCapture?.();
    app.quit();
  });

  process.on("SIGTERM", () => {
    if (isQuitting) return;
    isQuitting = true;
    writeDesktopLogHeader("SIGTERM received");
    clearUpdatePollTimer();
    stopBackend();
    restoreStdIoCapture?.();
    app.quit();
  });
}
