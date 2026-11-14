import "../../index.css";
import { expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";
import { Sidebar, SidebarInset, SidebarProvider, SidebarRail, useSidebar } from "./sidebar";
import { threadSidebarMobileBreakpoint } from "../../threadSidebarWidth";

function ResponsiveSidebarProbe() {
  const { isMobile, openMobile, toggleSidebar } = useSidebar();
  return (
    <button onClick={toggleSidebar}>
      {String(isMobile)}:{String(openMobile)}
    </button>
  );
}

it("uses the content floor for sheet mode and closes the sheet when widened", async () => {
  const breakpoint = threadSidebarMobileBreakpoint(256);
  await page.viewport(600, 780);
  const screen = await render(
    <SidebarProvider mobileBreakpoint={breakpoint}>
      <ResponsiveSidebarProbe />
    </SidebarProvider>,
  );
  await screen.getByRole("button", { name: "true:false" }).click();
  await expect.element(screen.getByRole("button", { name: "true:true" })).toBeVisible();
  await page.viewport(breakpoint, 780);
  await expect.element(screen.getByRole("button", { name: "false:false" })).toBeVisible();
  await page.viewport(600, 780);
  await expect.element(screen.getByRole("button", { name: "true:false" })).toBeVisible();
});

it.each([192, 256, 512])(
  "preserves the rendered content floor when leaving sheet mode with a %spx sidebar",
  async (width) => {
    await page.viewport(600, 780);
    const breakpoint = threadSidebarMobileBreakpoint(width);
    const screen = await render(
      <SidebarProvider
        mobileBreakpoint={breakpoint}
        style={{ "--sidebar-width": width + "px" } as React.CSSProperties}
      >
        <Sidebar variant="inset">Navigation</Sidebar>
        <SidebarInset data-testid="content">
          <ResponsiveSidebarProbe />
        </SidebarInset>
      </SidebarProvider>,
    );
    await page.viewport(720, 780);
    await expect.element(screen.getByRole("button", { name: "true:false" })).toBeVisible();
    await page.viewport(breakpoint, 780);
    await expect.element(screen.getByRole("button", { name: "false:false" })).toBeVisible();
    const content = screen.getByTestId("content").element();
    expect(content.getBoundingClientRect().width).toBeGreaterThanOrEqual(512);
    const sidebar = document.querySelector<HTMLElement>("[data-slot='sidebar-container']")!;
    expect(sidebar.getBoundingClientRect().width).toBe(width);
  },
);

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
