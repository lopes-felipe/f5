/** Guest input does not bubble into the host document. Close menus explicitly. */
export const PREVIEW_FOCUSED_EVENT = "f5:preview-focused";
export function notifyPreviewFocused() {
  window.dispatchEvent(new Event(PREVIEW_FOCUSED_EVENT));
}
