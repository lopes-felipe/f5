import "../../index.css";

import { page } from "vitest/browser";
import { expect, it } from "vitest";
import { render } from "vitest-browser-react";

import { AlertDialog, AlertDialogPopup, AlertDialogTitle } from "./alert-dialog";
import { Dialog, DialogPopup, DialogTitle } from "./dialog";

// In the desktop app a dialog can sit over the frameless titlebar's drag region, which would
// otherwise take every click on the dialog's top edge.
it("keeps dialogs clickable over the window drag region", async () => {
  await render(
    <>
      <div className="drag-region fixed inset-x-0 top-0 h-12" />
      <Dialog open>
        <DialogPopup>
          <DialogTitle>Rename thread</DialogTitle>
        </DialogPopup>
      </Dialog>
      <AlertDialog open>
        <AlertDialogPopup>
          <AlertDialogTitle>Delete thread?</AlertDialogTitle>
        </AlertDialogPopup>
      </AlertDialog>
    </>,
  );

  await expect.element(page.getByText("Delete thread?")).toBeVisible();
  for (const slot of ["dialog-popup", "alert-dialog-popup"]) {
    const popup = document.querySelector(`[data-slot="${slot}"]`);
    expect(popup).toBeInstanceOf(HTMLElement);
    expect(getComputedStyle(popup!).getPropertyValue("-webkit-app-region")).toBe("no-drag");
  }
});
