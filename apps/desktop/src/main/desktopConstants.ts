export const PICK_FOLDER_CHANNEL = "desktop:pick-folder";
export const CONFIRM_CHANNEL = "desktop:confirm";
export const SET_THEME_CHANNEL = "desktop:set-theme";
export const CONTEXT_MENU_CHANNEL = "desktop:context-menu";
export const READ_CLIPBOARD_TEXT_CHANNEL = "desktop:read-clipboard-text";
export const COPY_IMAGE_CHANNEL = "desktop:copy-image";
export const DOWNLOAD_IMAGE_CHANNEL = "desktop:download-image";
export const OPEN_EXTERNAL_CHANNEL = "desktop:open-external";
export const OPEN_THREAD_WINDOW_CHANNEL = "desktop:open-thread-window";
export const MAX_DESKTOP_WINDOWS = 12;
export const OPEN_THREAD_WINDOW_MIN_INTERVAL_MS = 500;
export const lastOpenThreadWindowAtByRenderer = new Map<number, number>();
export const MENU_ACTION_CHANNEL = "desktop:menu-action";
export const TRACKPAD_SCROLL_CHANNEL = "desktop:trackpad-scroll";
export const UPDATE_STATE_CHANNEL = "desktop:update-state";
export const UPDATE_GET_STATE_CHANNEL = "desktop:update-get-state";
export const UPDATE_DOWNLOAD_CHANNEL = "desktop:update-download";
export const UPDATE_INSTALL_CHANNEL = "desktop:update-install";
export const UPDATE_CHECK_CHANNEL = "desktop:update-check";
export const UPDATE_SET_CHANNEL_CHANNEL = "desktop:update-set-channel";
export const UPDATE_CLAIM_RECENT_INSTALL_CHANNEL = "desktop:update-claim-recent-install";
export const PREVIEW_RECORDING_FRAME_CHANNEL = "desktop-preview:recording-frame";
export const PREVIEW_STATE_CHANNEL = "desktop-preview:state";
export const lastPreviewStateEmissionByTabId = new Map<
  string,
  {
    readonly ownerWebContentsId: number;
    readonly stateKey: string;
    readonly faviconDataUrl: string | null;
  }
>();
export const PREVIEW_TAB_SCOPE_SEPARATOR = ":";

export const PREVIEW_WEBVIEW_PREFERENCES =
  "contextIsolation=true,sandbox=true,nodeIntegration=false";
export const PREVIEW_DEFAULT_ZOOM_FACTOR = 1;
export const PREVIEW_CAPTURE_MAX_EDGE_PX = 1600;
export const PREVIEW_CAPTURE_MAX_PIXELS = 2_000_000;
export const PREVIEW_AUTOMATION_MAX_EVALUATION_BYTES = 64_000;
export const PREVIEW_AUTOMATION_EVALUATE_DEFAULT_TIMEOUT_MS = 15_000;
export const PREVIEW_AUTOMATION_WAIT_INTERVAL_MS = 100;
export const PREVIEW_AUTOMATION_PRINTABLE_KEY_PATTERN = /^[A-Za-z0-9]$/;
export const PREVIEW_AUTOMATION_SUPPORTED_PUNCTUATION_KEYS: ReadonlySet<string> = new Set([
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
export const PREVIEW_AUTOMATION_SUPPORTED_NAMED_KEYS: ReadonlySet<string> = new Set([
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
