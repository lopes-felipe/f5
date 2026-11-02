import "../../index.css";
import { afterEach, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import type { DesktopBridge, DesktopUpdateState } from "@t3tools/contracts";

import { DesktopUpdateInstalledNotesDialog, DesktopUpdatePill } from "./DesktopUpdatePill";
import { useDesktopUpdate } from "./useDesktopUpdate";

const mocks = vi.hoisted(() => ({ toast: vi.fn() }));
vi.mock("../../env", () => ({ isElectron: true }));
vi.mock("../ui/toast", () => ({ toastManager: { add: mocks.toast } }));

const initial: DesktopUpdateState = {
  enabled: true,
  status: "idle",
  channel: "stable",
  currentVersion: "0.1.0",
  hostArch: "arm64",
  appArch: "arm64",
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
  window.localStorage.clear();
  vi.clearAllMocks();
});

function bridge(state: DesktopUpdateState = initial) {
  let emit: (next: DesktopUpdateState) => void = () => {};
  const download = vi.fn(async () => ({ accepted: true, completed: false, state }));
  const install = vi.fn(async () => ({ accepted: false, completed: false, state }));
  window.desktopBridge = {
    getUpdateState: async () => state,
    onUpdateState: (callback: (next: DesktopUpdateState) => void) => {
      emit = callback;
      return () => {};
    },
    downloadUpdate: download,
    installUpdate: install,
  } as unknown as DesktopBridge;
  return { download, install, emit: (next: DesktopUpdateState) => emit(next) };
}

function Harness() {
  const update = useDesktopUpdate({ announceInstall: true });
  return (
    <>
      <DesktopUpdatePill update={update} />
      <DesktopUpdateInstalledNotesDialog update={update} />
    </>
  );
}

it("stays hidden until there is an update to act on", async () => {
  const f = bridge();
  const screen = await render(<Harness />);
  f.emit({ ...initial, status: "up-to-date" });
  await expect.element(screen.getByRole("button")).not.toBeInTheDocument();
});

it("downloads from the popover and then shows live progress in the pill", async () => {
  const f = bridge();
  const screen = await render(<Harness />);
  f.emit({
    ...initial,
    status: "available",
    availableVersion: "0.2.0",
    releaseNotes: "Faster preview",
  });
  const pill = screen.getByRole("button", { name: "Update 0.2.0 ready to download" });
  await expect.element(pill).toHaveTextContent("0.2.0");
  await pill.click();
  await expect.element(screen.getByText("F5 0.2.0 is available")).toBeVisible();
  await screen.getByRole("button", { name: "Download", exact: true }).click();
  expect(f.download).toHaveBeenCalledTimes(1);

  f.emit({
    ...initial,
    status: "downloading",
    availableVersion: "0.2.0",
    downloadPercent: 42.4,
    downloadTransferredBytes: 38 * 1024 * 1024,
    downloadTotalBytes: 92 * 1024 * 1024,
  });
  await expect
    .element(screen.getByRole("button", { name: "Downloading update (42%)" }))
    .toHaveTextContent("42%");
  await expect
    .element(screen.getByRole("progressbar", { name: "Downloading 0.2.0" }))
    .toHaveAttribute("aria-valuenow", "42");
  await expect.element(screen.getByText("38 MB of 92 MB")).toBeVisible();
});

it("offers restart once downloaded and install steps while preparing", async () => {
  const f = bridge();
  const screen = await render(<Harness />);
  f.emit({ ...initial, status: "downloaded", downloadedVersion: "0.2.0" });
  const pill = screen.getByRole("button", { name: /Update 0.2.0 downloaded/ });
  await expect.element(pill).toHaveTextContent("Restart");
  await pill.click();
  await screen.getByRole("button", { name: "Restart to update…" }).click();
  expect(f.install).toHaveBeenCalledTimes(1);

  f.emit({
    ...initial,
    status: "preparing",
    downloadedVersion: "0.2.0",
    installPhase: "staging",
  });
  await expect.element(screen.getByText("Installing F5 0.2.0")).toBeVisible();
  await expect
    .element(screen.getByText("Verifying and unpacking the update. This can take a minute."))
    .toBeVisible();
});

it("announces a completed update once and opens its notes", async () => {
  const recentlyInstalled = {
    fromVersion: "0.1.0",
    toVersion: "0.2.0",
    releaseNotes: "Faster preview",
  };
  bridge({ ...initial, currentVersion: "0.2.0", recentlyInstalled });
  const screen = await render(<Harness />);
  await vi.waitFor(() => expect(mocks.toast).toHaveBeenCalledTimes(1));
  const toast = mocks.toast.mock.calls[0]![0] as {
    title: string;
    description: string;
    actionProps: { onClick: () => void };
  };
  expect(toast.title).toBe("Updated to F5 0.2.0");
  expect(toast.description).toBe("You were on 0.1.0.");
  toast.actionProps.onClick();
  await expect.element(screen.getByText("What’s new in F5 0.2.0")).toBeVisible();
  await expect.element(screen.getByText("Faster preview")).toBeVisible();

  screen.unmount();
  await render(<Harness />);
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(mocks.toast).toHaveBeenCalledTimes(1);
});
