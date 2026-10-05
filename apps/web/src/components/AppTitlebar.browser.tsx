import "../index.css";
import { describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";

import { AppTitlebar } from "./AppTitlebar";
import { SidebarProvider } from "./ui/sidebar";

describe("AppTitlebar", () => {
  it("shows the sidebar trigger only while the sidebar is collapsed", async () => {
    await page.viewport(1200, 800);
    const open = await render(
      <SidebarProvider defaultOpen>
        <AppTitlebar breadcrumb={[{ label: "Home" }]} />
      </SidebarProvider>,
    );
    await expect.element(open.getByRole("heading", { name: "Home" })).toBeVisible();
    expect(document.querySelector("[aria-label='Toggle sidebar']")).toBeNull();
    await open.unmount();

    const collapsed = await render(
      <SidebarProvider defaultOpen={false}>
        <AppTitlebar breadcrumb={[{ label: "Home" }]} />
      </SidebarProvider>,
    );
    await expect.element(collapsed.getByRole("button", { name: "Toggle sidebar" })).toBeVisible();
    await collapsed.unmount();
  });

  it("keeps a mobile-only bar visible at desktop widths while the sidebar is collapsed", async () => {
    await page.viewport(1200, 800);
    const open = await render(
      <SidebarProvider defaultOpen>
        <AppTitlebar webVisibility="mobile-only" breadcrumb={[{ label: "Home" }]} />
      </SidebarProvider>,
    );
    const openBar = document.querySelector<HTMLElement>("[data-slot='app-titlebar']");
    expect(openBar).not.toBeNull();
    expect(getComputedStyle(openBar!).display).toBe("none");
    await open.unmount();

    const collapsed = await render(
      <SidebarProvider defaultOpen={false}>
        <AppTitlebar webVisibility="mobile-only" breadcrumb={[{ label: "Home" }]} />
      </SidebarProvider>,
    );
    const collapsedBar = document.querySelector<HTMLElement>("[data-slot='app-titlebar']");
    expect(getComputedStyle(collapsedBar!).display).not.toBe("none");
    await collapsed.unmount();
  });

  it("renders breadcrumb ancestors as buttons and the last crumb as the heading", async () => {
    await page.viewport(1200, 800);
    const onSelect = vi.fn();
    const onClose = vi.fn();
    const screen = await render(
      <SidebarProvider defaultOpen>
        <AppTitlebar
          breadcrumb={[{ label: "f5", onSelect }, { label: "Fix the build" }]}
          trailing={<span>trailing</span>}
          onClose={onClose}
          closeLabel="Close panel"
        />
      </SidebarProvider>,
    );
    await screen.getByRole("button", { name: "f5" }).click();
    expect(onSelect).toHaveBeenCalledTimes(1);
    await expect.element(screen.getByRole("heading", { name: "Fix the build" })).toBeVisible();
    await screen.getByRole("button", { name: "Close panel" }).click();
    expect(onClose).toHaveBeenCalledTimes(1);
    await screen.unmount();
  });
});
