import "../../index.css";
import type { DesktopBridge, DesktopCliCommandState } from "@t3tools/contracts";
import { afterEach, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { CliCommandSettings } from "./CliCommandSettings";
const initial: DesktopCliCommandState = {
  supported: true,
  installedPaths: { f5: null, t3: null },
  onPath: false,
};
afterEach(() => {
  delete window.desktopBridge;
});
it("installs only on a click, disables repeat clicks and displays PATH instructions", async () => {
  let finish!: (next: DesktopCliCommandState) => void;
  const install = vi.fn(
    () =>
      new Promise<DesktopCliCommandState>((resolve) => {
        finish = resolve;
      }),
  );
  window.desktopBridge = {
    cliCommand: { state: async () => initial, install },
  } as unknown as DesktopBridge;
  const screen = await render(<CliCommandSettings />);
  const button = screen.getByRole("button", { name: "Install CLI commands" });
  await expect.element(button).toBeEnabled();
  expect(install).not.toHaveBeenCalled();
  await button.click();
  await expect.element(screen.getByRole("button", { name: "Installing…" })).toBeDisabled();
  finish({
    supported: true,
    installedPaths: { f5: "/home/me/.local/bin/f5", t3: "/home/me/.local/bin/t3" },
    onPath: false,
  });
  await expect
    .element(screen.getByRole("status"))
    .toHaveTextContent("Add their directories to PATH");
  expect(install).toHaveBeenCalledTimes(1);
});
it("warns and disables installation when another t3 runs first", async () => {
  const install = vi.fn();
  window.desktopBridge = {
    cliCommand: { state: async () => ({ ...initial, shadowedBy: "/other/t3" }), install },
  } as unknown as DesktopBridge;
  const screen = await render(<CliCommandSettings />);
  await expect.element(screen.getByRole("status")).toHaveTextContent("/other/t3");
  await expect.element(screen.getByRole("button", { name: "Install CLI commands" })).toBeDisabled();
  expect(install).not.toHaveBeenCalled();
});
it("shows a failed installation and allows retry", async () => {
  const install = vi.fn(async () => {
    throw new Error("Directory is not writable");
  });
  window.desktopBridge = {
    cliCommand: { state: async () => initial, install },
  } as unknown as DesktopBridge;
  const screen = await render(<CliCommandSettings />);
  await screen.getByRole("button", { name: "Install CLI commands" }).click();
  await expect.element(screen.getByRole("alert")).toHaveTextContent("Directory is not writable");
  await expect.element(screen.getByRole("button", { name: "Install CLI commands" })).toBeEnabled();
});
