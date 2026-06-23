import { contextBridge, ipcRenderer, webUtils } from "electron";
import type { DesktopBridge } from "@t3tools/contracts";

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
  openExternal: (url: string) => ipcRenderer.invoke(OPEN_EXTERNAL_CHANNEL, url),
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
