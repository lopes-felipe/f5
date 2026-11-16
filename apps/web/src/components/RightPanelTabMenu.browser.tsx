import "../index.css";
import { useState } from "react";
import { expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { userEvent } from "vitest/browser";
import { RightPanelTabMenu } from "./RightPanelTabMenu";
import type { RightPanelSurface } from "../rightPanelStore";
function Harness({ onActivate }: { onActivate: (surface: RightPanelSurface) => void }) {
  const [open, setOpen] = useState(true);
  return (
    <RightPanelTabMenu
      open={open}
      onOpenChange={setOpen}
      title={(surface) => surface.kind}
      onActivate={onActivate}
      surfaces={[
        { id: "diff", kind: "diff" },
        { id: "file:src/apple.ts", kind: "file", relativePath: "src/apple.ts", line: 42 },
        { id: "file:src/banana.ts", kind: "file", relativePath: "src/banana.ts" },
      ]}
    />
  );
}
it("searches file paths and selects the highlighted tab with the keyboard", async () => {
  const onActivate = vi.fn();
  const screen = await render(<Harness onActivate={onActivate} />);
  await screen.getByRole("combobox", { name: "Search panel tabs" }).fill("apple");
  await expect.element(screen.getByRole("option", { name: "src/apple.ts" })).toBeVisible();
  await expect
    .element(screen.getByRole("option", { name: "src/banana.ts" }))
    .not.toBeInTheDocument();
  await userEvent.keyboard("{Enter}");
  expect(onActivate).toHaveBeenCalledWith({
    id: "file:src/apple.ts",
    kind: "file",
    relativePath: "src/apple.ts",
    line: 42,
  });
  await expect
    .element(screen.getByRole("dialog", { name: "Switch panel tab" }))
    .not.toBeInTheDocument();
});
it("shows an empty result and Escape closes the menu without changing tabs", async () => {
  const onActivate = vi.fn();
  const screen = await render(<Harness onActivate={onActivate} />);
  await screen.getByRole("combobox", { name: "Search panel tabs" }).fill("absent");
  await expect.element(screen.getByText("No matching tabs.")).toBeVisible();
  await userEvent.keyboard("{Escape}");
  expect(onActivate).not.toHaveBeenCalled();
  await expect
    .element(screen.getByRole("dialog", { name: "Switch panel tab" }))
    .not.toBeInTheDocument();
});
