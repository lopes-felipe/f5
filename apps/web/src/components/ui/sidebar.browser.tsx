import "../../index.css";
import { expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";
import { Sidebar, SidebarProvider, SidebarRail } from "./sidebar";

it("retains the last drag width when pointer-up precedes the animation frame", async () => {
  await page.viewport(1200, 800);
  const onResize = vi.fn();
  const screen = await render(
    <SidebarProvider defaultOpen>
      <Sidebar resizable={{ minWidth: 100, onResize }}>
        <SidebarRail />
      </Sidebar>
    </SidebarProvider>,
  );
  const rail = screen
    .getByRole("button", { name: "Resize Sidebar" })
    .element() as HTMLButtonElement;
  const wrapper = rail.closest<HTMLElement>("[data-slot='sidebar-wrapper']")!;
  const container = rail
    .closest<HTMLElement>("[data-slot='sidebar']")!
    .querySelector<HTMLElement>("[data-slot='sidebar-container']")!;
  const width = container.getBoundingClientRect().width;
  const setCapture = vi.spyOn(rail, "setPointerCapture").mockImplementation(() => {});
  const hasCapture = vi.spyOn(rail, "hasPointerCapture").mockReturnValue(false);
  const raf = vi.spyOn(window, "requestAnimationFrame").mockReturnValue(999);
  const cancel = vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {});
  try {
    rail.dispatchEvent(
      new PointerEvent("pointerdown", { bubbles: true, pointerId: 1, button: 0, clientX: 100 }),
    );
    rail.dispatchEvent(
      new PointerEvent("pointermove", { bubbles: true, pointerId: 1, clientX: 137 }),
    );
    rail.dispatchEvent(
      new PointerEvent("pointerup", { bubbles: true, pointerId: 1, clientX: 137 }),
    );
    expect(onResize).toHaveBeenCalledWith(width + 37);
    expect(wrapper.style.getPropertyValue("--sidebar-width")).toBe(`${width + 37}px`);
    expect(document.body.style.cursor).toBe("");
    expect(document.body.style.userSelect).toBe("");
  } finally {
    setCapture.mockRestore();
    hasCapture.mockRestore();
    raf.mockRestore();
    cancel.mockRestore();
  }
});
