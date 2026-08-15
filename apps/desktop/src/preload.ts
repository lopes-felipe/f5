import { contextBridge, ipcRenderer, webUtils } from "electron";
import type { DesktopBridge } from "@t3tools/contracts";

const PICK_FOLDER_CHANNEL = "desktop:pick-folder";
const CONFIRM_CHANNEL = "desktop:confirm";
const SET_THEME_CHANNEL = "desktop:set-theme";
const CONTEXT_MENU_CHANNEL = "desktop:context-menu";
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
const PREVIEW_SET_VIEWPORT_CHANNEL = "desktop-preview:set-viewport";
const PREVIEW_CAPTURE_SCREENSHOT_CHANNEL = "desktop-preview:capture-screenshot";
const PREVIEW_RECORDING_START_CHANNEL = "desktop-preview:recording-start";
const PREVIEW_RECORDING_APPEND_CHANNEL = "desktop-preview:recording-append";
const PREVIEW_RECORDING_STOP_CHANNEL = "desktop-preview:recording-stop";
const PREVIEW_RECORDING_DISCARD_CHANNEL = "desktop-preview:recording-discard";
const PREVIEW_RECORDING_FRAME_CHANNEL = "desktop-preview:recording-frame";
const PREVIEW_STATE_CHANNEL = "desktop-preview:state";
const wsUrl = process.env.T3CODE_DESKTOP_WS_URL ?? null;

contextBridge.exposeInMainWorld("desktopBridge", {
  getWsUrl: () => wsUrl,
  getPathForFile: (file) => {
    const resolvedPath = webUtils.getPathForFile(file);
    return resolvedPath.length > 0 ? resolvedPath : null;
  },
  pickFolder: () => ipcRenderer.invoke(PICK_FOLDER_CHANNEL),
  confirm: (message) => ipcRenderer.invoke(CONFIRM_CHANNEL, message),
  setTheme: (theme) => ipcRenderer.invoke(SET_THEME_CHANNEL, theme),
  showContextMenu: (items, position) => ipcRenderer.invoke(CONTEXT_MENU_CHANNEL, items, position),
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
  preview: {
    getPreviewConfig: () => ipcRenderer.invoke(PREVIEW_GET_CONFIG_CHANNEL),
    createTab: (tabId) => ipcRenderer.invoke(PREVIEW_CREATE_TAB_CHANNEL, tabId),
    closeTab: (tabId) => ipcRenderer.invoke(PREVIEW_CLOSE_TAB_CHANNEL, tabId),
    registerWebview: (tabId, webContentsId) =>
      ipcRenderer.invoke(PREVIEW_REGISTER_WEBVIEW_CHANNEL, tabId, webContentsId),
    navigate: (tabId, url) => ipcRenderer.invoke(PREVIEW_NAVIGATE_CHANNEL, tabId, url),
    goBack: (tabId) => ipcRenderer.invoke(PREVIEW_GO_BACK_CHANNEL, tabId),
    goForward: (tabId) => ipcRenderer.invoke(PREVIEW_GO_FORWARD_CHANNEL, tabId),
    refresh: (tabId) => ipcRenderer.invoke(PREVIEW_REFRESH_CHANNEL, tabId),
    hardReload: (tabId) => ipcRenderer.invoke(PREVIEW_HARD_RELOAD_CHANNEL, tabId),
    openDevTools: (tabId) => ipcRenderer.invoke(PREVIEW_OPEN_DEVTOOLS_CHANNEL, tabId),
    pickElement: (tabId) => ipcRenderer.invoke(PREVIEW_PICK_ELEMENT_CHANNEL, tabId),
    cancelPickElement: (tabId) => ipcRenderer.invoke(PREVIEW_CANCEL_PICK_ELEMENT_CHANNEL, tabId),
    setViewport: (tabId, viewport) =>
      ipcRenderer.invoke(PREVIEW_SET_VIEWPORT_CHANNEL, tabId, viewport),
    captureScreenshot: (tabId) => ipcRenderer.invoke(PREVIEW_CAPTURE_SCREENSHOT_CHANNEL, tabId),
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
      snapshot: (tabId) => ipcRenderer.invoke(PREVIEW_AUTOMATION_SNAPSHOT_CHANNEL, tabId),
      click: (tabId, input) => ipcRenderer.invoke(PREVIEW_AUTOMATION_CLICK_CHANNEL, tabId, input),
      type: (tabId, input) => ipcRenderer.invoke(PREVIEW_AUTOMATION_TYPE_CHANNEL, tabId, input),
      press: (tabId, input) => ipcRenderer.invoke(PREVIEW_AUTOMATION_PRESS_CHANNEL, tabId, input),
      scroll: (tabId, input) => ipcRenderer.invoke(PREVIEW_AUTOMATION_SCROLL_CHANNEL, tabId, input),
      evaluate: (tabId, input) =>
        ipcRenderer.invoke(PREVIEW_AUTOMATION_EVALUATE_CHANNEL, tabId, input),
      waitFor: (tabId, input) =>
        ipcRenderer.invoke(PREVIEW_AUTOMATION_WAIT_FOR_CHANNEL, tabId, input),
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
