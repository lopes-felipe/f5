import { afterEach, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { page } from "vitest/browser";
import { SidebarFolderDrop } from "./SidebarFolderDrop";

const mocks = vi.hoisted(() => ({ open: vi.fn(async () => {}), toast: vi.fn() }));
vi.mock("../../hooks/useOpenLocalWorkspace", () => ({
  useOpenLocalWorkspace: () => ({ ready: true, open: mocks.open }),
}));
vi.mock("../ui/toast", () => ({ toastManager: { add: mocks.toast } }));
const previousBridge = window.desktopBridge;
afterEach(() => {
  Object.defineProperty(window, "desktopBridge", { value: previousBridge, configurable: true });
  vi.clearAllMocks();
});
function drop(folders: boolean[]) {
  const files = folders.map((_, index) => new File([""], "folder-" + index));
  const event = new DragEvent("drop", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "dataTransfer", {
    value: {
      types: ["Files"],
      files,
      items: files.map((file, index) => ({
        kind: "file",
        getAsFile: () => file,
        webkitGetAsEntry: () => ({ isDirectory: folders[index] }),
      })),
    },
  });
  document.querySelector("[data-testid=drop-content]")!.parentElement!.dispatchEvent(event);
}
it("opens dropped folders in order and gives plain files a hint", async () => {
  Object.defineProperty(window, "desktopBridge", {
    configurable: true,
    value: { getPathForFile: (file: File) => "/repo/" + file.name },
  });
  const view = await render(
    <SidebarFolderDrop>
      <div data-testid="drop-content">Projects</div>
    </SidebarFolderDrop>,
  );
  try {
    drop([true, false, true]);
    await vi.waitFor(() =>
      expect(mocks.open.mock.calls).toEqual([["/repo/folder-0"], ["/repo/folder-2"]]),
    );
    expect(mocks.toast).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Only folders can be added as projects" }),
    );
  } finally {
    await view.unmount();
  }
});
it("does not attempt a pathless browser folder open", async () => {
  Object.defineProperty(window, "desktopBridge", { configurable: true, value: undefined });
  const view = await render(
    <SidebarFolderDrop>
      <div data-testid="drop-content">Projects</div>
    </SidebarFolderDrop>,
  );
  try {
    drop([true]);
    await vi.waitFor(() => expect(mocks.toast).toHaveBeenCalled());
    expect(mocks.open).not.toHaveBeenCalled();
    await expect.element(page.getByText("Projects", { exact: true })).toBeVisible();
  } finally {
    await view.unmount();
  }
});
