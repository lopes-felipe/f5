import "../../index.css";
import type { AppIconId, DesktopBridge } from "@t3tools/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { AppIconEffects } from "../../appIcon";
import { parsePersistedAppSettings } from "../../appSettings";
import { F5Icon } from "../sidebar/SidebarBrandHeader";
import { AppIconPicker, appIconHelpText } from "./AppIconPicker";

const mocks = vi.hoisted(() => ({ toast: vi.fn() }));
vi.mock("../ui/toast", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../ui/toast")>()),
  toastManager: { add: mocks.toast },
}));

const APP_SETTINGS_STORAGE_KEY = "t3code:app-settings:v1";

function Harness() {
  return (
    <>
      <AppIconEffects />
      <F5Icon />
      <AppIconPicker />
    </>
  );
}

function desktopBridge(initial: AppIconId, options: { dockPrompt?: boolean } = {}) {
  const listeners = new Set<(id: AppIconId) => void>();
  const set = vi.fn(async (_id: AppIconId) => {});
  const restartDock = vi.fn(async () => {});
  window.desktopBridge = {
    appIcon: {
      initial,
      set,
      onChange: (listener: (id: AppIconId) => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      claimDockRefreshPrompt: async () => options.dockPrompt ?? false,
      restartDock,
    },
  } as unknown as DesktopBridge;
  return {
    set,
    restartDock,
    announce: (id: AppIconId) => {
      for (const listener of listeners) listener(id);
    },
  };
}

const tabIcon = () => document.querySelector<HTMLLinkElement>('link[rel="icon"]')!;
const logoPath = () =>
  new URL(document.querySelector<HTMLImageElement>('img[alt="F5"]')!.src).pathname;

describe("AppIconPicker", () => {
  beforeEach(() => {
    for (const link of document.querySelectorAll('link[rel="icon"]')) link.remove();
    const link = document.createElement("link");
    link.rel = "icon";
    link.setAttribute("href", "/favicon.ico");
    link.setAttribute("sizes", "48x48");
    document.head.append(link);
  });
  afterEach(() => {
    delete window.desktopBridge;
    localStorage.clear();
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  it("changes the sidebar logo and the tab icon in a browser, and remembers the choice", async () => {
    const screen = await render(<Harness />);
    await expect.element(screen.getByRole("radio", { name: "Lines" })).toBeChecked();
    await expect
      .element(screen.getByText("Shown in the sidebar and the browser tab."))
      .toBeVisible();
    expect(screen.getByRole("radio").elements()).toHaveLength(10);

    await screen.getByRole("radio", { name: "Classic" }).click();
    await expect.element(screen.getByRole("radio", { name: "Classic" })).toBeChecked();
    await expect.poll(logoPath).toBe("/app-icons/classic.png");
    expect(tabIcon().getAttribute("href")).toBe("/app-icons/classic-32.png");
    expect(tabIcon().getAttribute("sizes")).toBe("32x32");
    expect(parsePersistedAppSettings(localStorage.getItem(APP_SETTINGS_STORAGE_KEY)).appIcon).toBe(
      "classic",
    );

    await screen.getByRole("radio", { name: "Lines" }).click();
    await expect.poll(logoPath).toBe("/app-icons/lines.png");
    expect(tabIcon().getAttribute("href")).toBe("/favicon.ico");
    expect(tabIcon().getAttribute("sizes")).toBe("48x48");
  });

  it("asks the desktop app to change, and follows what it announces", async () => {
    const bridge = desktopBridge("mono");
    const screen = await render(<Harness />);
    await expect.element(screen.getByRole("radio", { name: "Mono" })).toBeChecked();
    expect(logoPath()).toBe("/app-icons/mono.png");

    await screen.getByRole("radio", { name: "Blue" }).click();
    expect(bridge.set).toHaveBeenCalledWith("blue");
    // The choice belongs to the desktop app: nothing changes until it says so.
    await expect.element(screen.getByRole("radio", { name: "Mono" })).toBeChecked();
    expect(localStorage.getItem(APP_SETTINGS_STORAGE_KEY)).toBeNull();

    bridge.announce("blue");
    await expect.element(screen.getByRole("radio", { name: "Blue" })).toBeChecked();
    await expect.poll(logoPath).toBe("/app-icons/blue.png");
    expect(mocks.toast).not.toHaveBeenCalled();
  });

  it("reports a change the desktop app refused", async () => {
    const bridge = desktopBridge("lines");
    bridge.set.mockRejectedValueOnce(new Error("Unknown app icon"));
    const screen = await render(<Harness />);
    await screen.getByRole("radio", { name: "Glow" }).click();
    await expect
      .poll(() => mocks.toast.mock.calls.at(-1)?.[0])
      .toMatchObject({ type: "error", title: "Could not change the app icon" });
  });

  it("offers to restart a Dock that still shows the old icon", async () => {
    const bridge = desktopBridge("lines", { dockPrompt: true });
    await render(<Harness />);
    await expect.poll(() => mocks.toast.mock.calls.length).toBe(1);
    const toast = mocks.toast.mock.calls[0]![0];
    expect(toast).toMatchObject({
      title: "F5 has a new icon",
      description:
        "The Dock is still showing the old one. Notification banners update after your next login.",
      timeout: 0,
      actionProps: { children: "Restart Dock" },
    });
    expect(bridge.restartDock).not.toHaveBeenCalled();
    toast.actionProps.onClick();
    expect(bridge.restartDock).toHaveBeenCalledOnce();
  });

  it("says nothing when the Dock is up to date", async () => {
    desktopBridge("lines");
    const screen = await render(<Harness />);
    await expect.element(screen.getByRole("radio", { name: "Lines" })).toBeChecked();
    expect(mocks.toast).not.toHaveBeenCalled();
  });

  it("explains where the icon shows on each platform", () => {
    expect(appIconHelpText(true, "MacIntel")).toBe(
      "Shown in the Dock, the app switcher and the sidebar. Finder, Launchpad and notifications keep the default icon.",
    );
    expect(appIconHelpText(true, "Win32")).toBe(
      "Shown in the taskbar while F5 is open, and in the sidebar.",
    );
    expect(appIconHelpText(true, "Linux x86_64")).toBe(
      "Shown in the taskbar while F5 is open, and in the sidebar.",
    );
    expect(appIconHelpText(false, "MacIntel")).toBe("Shown in the sidebar and the browser tab.");
  });
});
