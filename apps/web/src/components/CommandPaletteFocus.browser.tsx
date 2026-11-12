import "../index.css";

import { useState } from "react";
import { expect, it } from "vitest";
import { page, userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";
import { Command, CommandDialog, CommandDialogPopup, CommandInput } from "./ui/command";

function Palette() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button onClick={() => setOpen(true)}>Open palette</button>
      <CommandDialog open={open} onOpenChange={setOpen}>
        <CommandDialogPopup aria-label="Projects">
          <button>Back</button>
          <Command>
            <CommandInput placeholder="Search projects" />
          </Command>
        </CommandDialogPopup>
      </CommandDialog>
    </>
  );
}

it("focuses search before a submenu Back button", async () => {
  await render(<Palette />);
  await userEvent.click(page.getByRole("button", { name: "Open palette" }));
  await expect.element(page.getByPlaceholder("Search projects")).toHaveFocus();
});
