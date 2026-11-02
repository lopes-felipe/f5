import "../../../index.css";
import { afterEach, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import type { DesktopBridge, DesktopUpdateState } from "@t3tools/contracts";
import { AboutSettings } from "./AboutSettings";
const mocks = vi.hoisted(() => ({ toast: vi.fn() }));
vi.mock("../../../env", () => ({ isElectron: true }));
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => vi.fn() }));
vi.mock("../SettingsRouteContext", () => ({
  useSettingsRouteContext: () => ({
    settings: { onboardingLiteStatus: "eligible" },
    updateSettings: vi.fn(),
  }),
}));
vi.mock("../../ui/toast", () => ({ toastManager: { add: mocks.toast } }));
const initial: DesktopUpdateState = {
  enabled: true,
  status: "idle",
  channel: "stable",
  currentVersion: "0.1.0",
  hostArch: "x64",
  appArch: "x64",
  runningUnderArm64Translation: false,
  availableVersion: null,
  downloadedVersion: null,
  releaseNotes: null,
  downloadPercent: null,
  checkedAt: null,
  message: null,
  errorContext: null,
  canRetry: false,
};
afterEach(() => {
  delete window.desktopBridge;
  vi.clearAllMocks();
});
function bridge(optional = true) {
  let emit: (state: DesktopUpdateState) => void = () => {};
  const check = vi.fn(async () => ({
    accepted: true,
    completed: false,
    state: { ...initial, status: "error" as const, message: "offline" },
  }));
  const setChannel = vi.fn(async (_channel: string) => ({
    accepted: true,
    completed: true,
    state: initial,
  }));
  window.desktopBridge = {
    getUpdateState: async () => initial,
    onUpdateState: (callback: (state: DesktopUpdateState) => void) => {
      emit = callback;
      return () => {};
    },
    ...(optional ? { checkForUpdates: check, setUpdateChannel: setChannel } : {}),
  } as unknown as DesktopBridge;
  return { check, setChannel, emit: (state: DesktopUpdateState) => emit(state) };
}
it("checks manually and renders subscription state after a failed check", async () => {
  const f = bridge();
  const screen = await render(<AboutSettings />);
  const button = screen.getByRole("button", { name: "Check for updates" });
  await button.click();
  expect(f.check).toHaveBeenCalledTimes(1);
  await expect.element(button).toBeEnabled();
  f.emit({ ...initial, status: "up-to-date", checkedAt: new Date().toISOString() });
  await expect.element(screen.getByRole("status")).toHaveTextContent("F5 is up to date");
});
it("disables beta switch while channel change is pending", async () => {
  const f = bridge();
  let finish!: () => void;
  f.setChannel.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = () => resolve({ accepted: true, completed: true, state: initial });
      }),
  );
  const screen = await render(<AboutSettings />);
  const toggle = screen.getByRole("switch", { name: "Beta updates" });
  await toggle.click();
  expect(f.setChannel).toHaveBeenCalledWith("beta");
  await expect.element(toggle).toBeDisabled();
  finish();
  await expect.element(toggle).toBeEnabled();
});
it("hides actions for older bridges", async () => {
  bridge(false);
  const screen = await render(<AboutSettings />);
  await expect
    .element(screen.getByRole("button", { name: "Check for updates" }))
    .not.toBeInTheDocument();
  await expect
    .element(screen.getByRole("switch", { name: "Beta updates" }))
    .not.toBeInTheDocument();
});
it.each(["confirmation cancel", "window veto"])("does not toast an error for %s", async () => {
  const f = bridge();
  const state = {
    ...initial,
    status: "downloaded" as const,
    downloadedVersion: "0.2.0",
    message: "Previous installation failed",
  };
  const install = vi.fn(async () => ({ accepted: false, completed: false, state }));
  window.desktopBridge!.installUpdate = install;
  const screen = await render(<AboutSettings />);
  f.emit(state);
  await screen.getByRole("button", { name: "Restart to update" }).click();
  await vi.waitFor(() => expect(install).toHaveBeenCalledTimes(1));
  expect(mocks.toast).not.toHaveBeenCalled();
});
it("shows preparation progress and disables install and channel actions", async () => {
  const f = bridge();
  const screen = await render(<AboutSettings />);
  f.emit({ ...initial, status: "preparing", downloadedVersion: "0.2.0" });
  await expect.element(screen.getByRole("button", { name: "Preparing update…" })).toBeDisabled();
  await expect.element(screen.getByRole("switch", { name: "Beta updates" })).toBeDisabled();
  await expect
    .element(screen.getByText("Verifying and unpacking the update. This can take a minute."))
    .toBeVisible();
  f.emit({
    ...initial,
    status: "preparing",
    downloadedVersion: "0.2.0",
    installPhase: "stopping",
  });
  await expect.element(screen.getByText("Closing windows and stopping agents…")).toBeVisible();
});
it("renders a download progress bar with bytes and speed", async () => {
  const f = bridge();
  const screen = await render(<AboutSettings />);
  const MB = 1024 * 1024;
  f.emit({
    ...initial,
    status: "downloading",
    availableVersion: "0.2.0",
    downloadPercent: 42,
    downloadTransferredBytes: 38 * MB,
    downloadTotalBytes: 92 * MB,
    downloadBytesPerSecond: 4 * MB,
  });
  const bar = screen.getByRole("progressbar", { name: "Downloading 0.2.0" });
  await expect.element(bar).toHaveAttribute("aria-valuenow", "42");
  await expect.element(screen.getByText(/38 MB of 92 MB · 4 MB\/s/)).toBeVisible();
});
