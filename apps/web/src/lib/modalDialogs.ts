// Toasts, including the undo notice, are non-modal dialogs and must not block shortcuts or gestures.
export const MODAL_DIALOG_SELECTOR =
  '[role="dialog"]:not([aria-modal="false"]), [role="alertdialog"]:not([aria-modal="false"])';

export function isModalDialogOpen(): boolean {
  return document.querySelector(MODAL_DIALOG_SELECTOR) !== null;
}
