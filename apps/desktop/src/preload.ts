import { contextBridge, ipcRenderer, webUtils } from "electron";
import type { DesktopBridge } from "@t3tools/contracts";

const PICK_FOLDER_CHANNEL = "desktop:pick-folder";
const CONFIRM_CHANNEL = "desktop:confirm";
const SET_THEME_CHANNEL = "desktop:set-theme";
const CONTEXT_MENU_CHANNEL = "desktop:context-menu";
const READ_CLIPBOARD_TEXT_CHANNEL = "desktop:read-clipboard-text";
const COPY_IMAGE_CHANNEL = "desktop:copy-image";
const DOWNLOAD_IMAGE_CHANNEL = "desktop:download-image";
const OPEN_EXTERNAL_CHANNEL = "desktop:open-external";
const OPEN_THREAD_WINDOW_CHANNEL = "desktop:open-thread-window";
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
const PREVIEW_AUTOMATION_CANCEL_CHANNEL = "desktop-preview:automation-cancel";
const PREVIEW_SET_NAVIGATION_POLICY_CHANNEL = "desktop-preview:set-navigation-policy";
const PREVIEW_CAPTURE_THUMBNAIL_CHANNEL = "desktop-preview:capture-thumbnail";
const PREVIEW_SET_VIEWPORT_CHANNEL = "desktop-preview:set-viewport";
const PREVIEW_SET_COLOR_SCHEME_CHANNEL = "desktop-preview:set-color-scheme";
const PREVIEW_CAPTURE_SCREENSHOT_CHANNEL = "desktop-preview:capture-screenshot";
const PREVIEW_SET_ARTIFACT_RETENTION_CHANNEL = "desktop-preview:set-artifact-retention";
const PREVIEW_RECORDING_START_CHANNEL = "desktop-preview:recording-start";
const PREVIEW_RECORDING_APPEND_CHANNEL = "desktop-preview:recording-append";
const PREVIEW_RECORDING_STOP_CHANNEL = "desktop-preview:recording-stop";
const PREVIEW_RECORDING_DISCARD_CHANNEL = "desktop-preview:recording-discard";
const PREVIEW_RECORDING_FRAME_CHANNEL = "desktop-preview:recording-frame";
const PREVIEW_STATE_CHANNEL = "desktop-preview:state";
const argument = (name: string) =>
  process.argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3) ?? null;
// Keep the synchronous bridge contract; credentials are obtained only by the owning preload.
const wsUrl: string | null = ipcRenderer.sendSync("desktop:get-ws-url") ?? null;
const profileId = argument("f5-profile-id");
const systemLocale = argument("f5-system-locale");

contextBridge.exposeInMainWorld("desktopBridge", {
  computerAutomation: {
    status: () => ipcRenderer.invoke("desktop-computer:status"),
  },
  getSystemLocale: () => systemLocale,
  setQuitShortcutMode: (mode) => ipcRenderer.invoke("desktop:quit-mode", mode),
  setAttentionBadge: (count) => ipcRenderer.invoke("desktop:attention-badge", count),
  onQuitShortcut: (listener) => {
    const wrapped = (_event: Electron.IpcRendererEvent, hint: Parameters<typeof listener>[0]) =>
      listener(hint);
    ipcRenderer.on("desktop:quit-hint", wrapped);
    return () => ipcRenderer.removeListener("desktop:quit-hint", wrapped);
  },
  getWsUrl: () => wsUrl,
  getProfileId: () => profileId,
  switchProfile: (id) => ipcRenderer.invoke("desktop:switch-profile", id),
  stopProfile: (id) => ipcRenderer.invoke("desktop:stop-profile", id),
  onProfilesChanged: (listener) => {
    const wrapped = () => listener();
    ipcRenderer.on("desktop:profiles-changed", wrapped);
    return () => {
      ipcRenderer.removeListener("desktop:profiles-changed", wrapped);
    };
  },
  getPathForFile: (file) => {
    const resolvedPath = webUtils.getPathForFile(file);
    return resolvedPath.length > 0 ? resolvedPath : null;
  },
  pickFolder: () => ipcRenderer.invoke(PICK_FOLDER_CHANNEL),
  confirm: (message) => ipcRenderer.invoke(CONFIRM_CHANNEL, message),
  setTheme: (theme) => ipcRenderer.invoke(SET_THEME_CHANNEL, theme),
  showContextMenu: (items, position) => ipcRenderer.invoke(CONTEXT_MENU_CHANNEL, items, position),
  readClipboardText: (source) => ipcRenderer.invoke(READ_CLIPBOARD_TEXT_CHANNEL, source),
  copyImage: (pngBytes) => ipcRenderer.invoke(COPY_IMAGE_CHANNEL, pngBytes),
  downloadImage: (bytes, filename) => ipcRenderer.invoke(DOWNLOAD_IMAGE_CHANNEL, bytes, filename),
  openExternal: (url: string) => ipcRenderer.invoke(OPEN_EXTERNAL_CHANNEL, url),
  openThreadInNewWindow: (threadId: string) =>
    ipcRenderer.invoke(OPEN_THREAD_WINDOW_CHANNEL, threadId),
  onMenuAction: (listener) => {
    const wrappedListener = (_event: Electron.IpcRendererEvent, action: unknown) => {
      if (typeof action !== "string") return;
      listener(action);
    };

    ipcRenderer.on(MENU_ACTION_CHANNEL, wrappedListener);
    return () => {
      ipcRenderer.removeListener(MENU_ACTION_CHANNEL, wrappedListener);
    };
  },
  getUpdateState: () => ipcRenderer.invoke(UPDATE_GET_STATE_CHANNEL),
  downloadUpdate: () => ipcRenderer.invoke(UPDATE_DOWNLOAD_CHANNEL),
  installUpdate: () => ipcRenderer.invoke(UPDATE_INSTALL_CHANNEL),
  onUpdateState: (listener) => {
    const wrappedListener = (_event: Electron.IpcRendererEvent, state: unknown) => {
      if (typeof state !== "object" || state === null) return;
      listener(state as Parameters<typeof listener>[0]);
    };

    ipcRenderer.on(UPDATE_STATE_CHANNEL, wrappedListener);
    return () => {
      ipcRenderer.removeListener(UPDATE_STATE_CHANNEL, wrappedListener);
    };
  },
  snapShot: {
    permissions: () => ipcRenderer.invoke("snapshot:permissions"),
    capture: () => ipcRenderer.invoke("snapshot:capture"),
    configure: (shortcut, enabled) => ipcRenderer.invoke("snapshot:configure", shortcut, enabled),
    openPermissions: () => ipcRenderer.invoke("snapshot:permissions-open"),
    onCapture: (listener) => {
      const handler = (_event: Electron.IpcRendererEvent, result: Parameters<typeof listener>[0]) =>
        listener(result);
      ipcRenderer.on("snapshot:captured", handler);
      return () => {
        ipcRenderer.removeListener("snapshot:captured", handler);
      };
    },
  },
  preview: {
    getPreviewConfig: () => ipcRenderer.invoke(PREVIEW_GET_CONFIG_CHANNEL),
    createTab: (tabId, defaults) => ipcRenderer.invoke(PREVIEW_CREATE_TAB_CHANNEL, tabId, defaults),
    profiles: {
      list: () => ipcRenderer.invoke("browser-profiles:list"),
      create: (name, persistent) => ipcRenderer.invoke("browser-profiles:create", name, persistent),
      select: (id) => ipcRenderer.invoke("browser-profiles:select", id),
      delete: (id) => ipcRenderer.invoke("browser-profiles:delete", id),
    },
    browserImport: {
      openPermissions: () => ipcRenderer.invoke("browser-import:permissions"),
      sources: () => ipcRenderer.invoke("browser-import:sources"),
      start: (source, profile, name) =>
        ipcRenderer.invoke("browser-import:start", source, profile, name),
      cancel: (id) => ipcRenderer.invoke("browser-import:cancel", id),
      status: (id) => ipcRenderer.invoke("browser-import:status", id),
    },
    setLinkOpenTarget: (target) => ipcRenderer.invoke("desktop-preview:link-target", target),
    onOpenLink: (listener) => {
      const handler = (_event: Electron.IpcRendererEvent, url: string) => listener(url);
      ipcRenderer.on("desktop-preview:open-link", handler);
      return () => {
        ipcRenderer.removeListener("desktop-preview:open-link", handler);
      };
    },
    setMuted: (tab, muted) => ipcRenderer.invoke("desktop-preview:muted", tab, muted),
    setZoom: (tab, factor) => ipcRenderer.invoke("desktop-preview:zoom", tab, factor),
    closeTab: (tabId) => ipcRenderer.invoke(PREVIEW_CLOSE_TAB_CHANNEL, tabId),
    registerWebview: (tabId, webContentsId) =>
      ipcRenderer.invoke(PREVIEW_REGISTER_WEBVIEW_CHANNEL, tabId, webContentsId),
    navigate: (tabId, url, options) =>
      ipcRenderer.invoke(PREVIEW_NAVIGATE_CHANNEL, tabId, url, options),
    goBack: (tabId) => ipcRenderer.invoke(PREVIEW_GO_BACK_CHANNEL, tabId),
    goForward: (tabId) => ipcRenderer.invoke(PREVIEW_GO_FORWARD_CHANNEL, tabId),
    refresh: (tabId) => ipcRenderer.invoke(PREVIEW_REFRESH_CHANNEL, tabId),
    hardReload: (tabId) => ipcRenderer.invoke(PREVIEW_HARD_RELOAD_CHANNEL, tabId),
    openDevTools: (tabId) => ipcRenderer.invoke(PREVIEW_OPEN_DEVTOOLS_CHANNEL, tabId),
    pickElement: (tabId) => ipcRenderer.invoke(PREVIEW_PICK_ELEMENT_CHANNEL, tabId),
    cancelPickElement: (tabId) => ipcRenderer.invoke(PREVIEW_CANCEL_PICK_ELEMENT_CHANNEL, tabId),
    setViewport: (tabId, viewport) =>
      ipcRenderer.invoke(PREVIEW_SET_VIEWPORT_CHANNEL, tabId, viewport),
    setColorScheme: (tabId, colorScheme) =>
      ipcRenderer.invoke(PREVIEW_SET_COLOR_SCHEME_CHANNEL, tabId, colorScheme),
    captureScreenshot: (tabId) => ipcRenderer.invoke(PREVIEW_CAPTURE_SCREENSHOT_CHANNEL, tabId),
    setArtifactRetention: (days) =>
      ipcRenderer.invoke(PREVIEW_SET_ARTIFACT_RETENTION_CHANNEL, days),
    recording: {
      start: (tabId) => ipcRenderer.invoke(PREVIEW_RECORDING_START_CHANNEL, tabId),
      appendChunk: (recordingId, chunk) =>
        ipcRenderer.invoke(PREVIEW_RECORDING_APPEND_CHANNEL, recordingId, chunk),
      stop: (recordingId) => ipcRenderer.invoke(PREVIEW_RECORDING_STOP_CHANNEL, recordingId),
      discard: (recordingId) => ipcRenderer.invoke(PREVIEW_RECORDING_DISCARD_CHANNEL, recordingId),
      onFrame: (listener) => {
        const wrappedListener = (_event: Electron.IpcRendererEvent, frame: unknown) => {
          if (typeof frame !== "object" || frame === null) return;
          listener(frame as Parameters<typeof listener>[0]);
        };
        ipcRenderer.on(PREVIEW_RECORDING_FRAME_CHANNEL, wrappedListener);
        return () => ipcRenderer.removeListener(PREVIEW_RECORDING_FRAME_CHANNEL, wrappedListener);
      },
    },
    automation: {
      status: (tabId) => ipcRenderer.invoke(PREVIEW_AUTOMATION_STATUS_CHANNEL, tabId),
      snapshot: (tabId, save) =>
        ipcRenderer.invoke(PREVIEW_AUTOMATION_SNAPSHOT_CHANNEL, tabId, save),
      click: (tabId, input) => ipcRenderer.invoke(PREVIEW_AUTOMATION_CLICK_CHANNEL, tabId, input),
      type: (tabId, input) => ipcRenderer.invoke(PREVIEW_AUTOMATION_TYPE_CHANNEL, tabId, input),
      press: (tabId, input) => ipcRenderer.invoke(PREVIEW_AUTOMATION_PRESS_CHANNEL, tabId, input),
      scroll: (tabId, input) => ipcRenderer.invoke(PREVIEW_AUTOMATION_SCROLL_CHANNEL, tabId, input),
      evaluate: (tabId, input) =>
        ipcRenderer.invoke(PREVIEW_AUTOMATION_EVALUATE_CHANNEL, tabId, input),
      waitFor: (tabId, input) =>
        ipcRenderer.invoke(PREVIEW_AUTOMATION_WAIT_FOR_CHANNEL, tabId, input),
      cancel: (tabId) => ipcRenderer.invoke(PREVIEW_AUTOMATION_CANCEL_CHANNEL, tabId),
      setNavigationPolicy: (tabId, externalHosts) =>
        ipcRenderer.invoke(PREVIEW_SET_NAVIGATION_POLICY_CHANNEL, tabId, externalHosts),
      captureThumbnail: (tabId) => ipcRenderer.invoke(PREVIEW_CAPTURE_THUMBNAIL_CHANNEL, tabId),
    },
    onStateChange: (listener) => {
      const wrappedListener = (
        _event: Electron.IpcRendererEvent,
        tabId: unknown,
        state: unknown,
      ) => {
        if (typeof tabId !== "string" || typeof state !== "object" || state === null) return;
        listener(tabId, state as Parameters<typeof listener>[1]);
      };

      ipcRenderer.on(PREVIEW_STATE_CHANNEL, wrappedListener);
      return () => {
        ipcRenderer.removeListener(PREVIEW_STATE_CHANNEL, wrappedListener);
      };
    },
  },
} satisfies DesktopBridge);
