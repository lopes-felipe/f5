import { afterEach, expect, it, vi } from "vitest";
import type { NativeApi } from "@t3tools/contracts";
import { openInPreferredEditor } from "./editorPreferences";
import { showFileEntryContextMenu } from "./components/fileEntryActions";

vi.mock("./hooks/useLocalStorage", () => ({
  getLocalStorageItem: () => null,
  setLocalStorageItem: vi.fn(),
  useLocalStorage: vi.fn(),
}));
vi.mock("./components/ui/toast", () => ({ toastManager: { add: vi.fn() } }));
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it("captures authorization before a getConfig request longer than the old gesture deadline", async () => {
  vi.useFakeTimers();
  const prepare = vi.fn().mockResolvedValue("native-token");
  vi.stubGlobal("window", { desktopBridge: { prepareEditorOpen: prepare } });
  const getConfig = vi.fn(
    () =>
      new Promise((resolve) => setTimeout(() => resolve({ availableEditors: ["vscode"] }), 1500)),
  );
  const open = vi.fn();
  const api = { server: { getConfig }, shell: { openInEditor: open } } as unknown as NativeApi;
  const pending = openInPreferredEditor(api, "/repo/report.json");
  await vi.advanceTimersByTimeAsync(0);
  expect(prepare).toHaveBeenCalledWith("/repo/report.json");
  expect(prepare.mock.invocationCallOrder[0]).toBeLessThan(getConfig.mock.invocationCallOrder[0]!);
  await vi.advanceTimersByTimeAsync(1500);
  await pending;
  expect(open).toHaveBeenCalledWith("/repo/report.json", "vscode", "native-token");
});

it("carries the selected native file-menu target into preferred-editor authorization", async () => {
  const prepare = vi.fn().mockResolvedValue("menu-token");
  vi.stubGlobal("window", { desktopBridge: { prepareEditorOpen: prepare } });
  const show = vi.fn().mockResolvedValue("open-in-editor");
  const open = vi.fn();
  const api = {
    contextMenu: { show },
    server: { getConfig: vi.fn().mockResolvedValue({ availableEditors: ["vscode"] }) },
    shell: { openInEditor: open },
  } as unknown as NativeApi;
  await showFileEntryContextMenu({
    api,
    cwd: "/repo",
    projectId: "project" as never,
    threadId: "thread" as never,
    entry: { path: "report.json", kind: "file" },
    position: { x: 1, y: 2 },
    onAddToChat: () => false,
  });
  expect(show).toHaveBeenCalledWith(
    expect.any(Array),
    { x: 1, y: 2 },
    { editorTarget: "/repo/report.json" },
  );
  expect(prepare).toHaveBeenCalledWith("/repo/report.json");
  expect(open).toHaveBeenCalledWith("/repo/report.json", "vscode", "menu-token");
});

it.each(["vscode", "zed", "file-manager"])(
  "releases prepared grants after opening %s, including more than 128 consecutive opens",
  async (editor) => {
    const pending = new Set<string>();
    let sequence = 0;
    const prepare = vi.fn(async () => {
      if (pending.size >= 128) throw new Error("Too many pending file actions.");
      const token = `token-${++sequence}`;
      pending.add(token);
      return token;
    });
    const release = vi.fn(async (token: string) => {
      pending.delete(token);
    });
    vi.stubGlobal("window", {
      desktopBridge: { prepareEditorOpen: prepare, releaseEditorOpen: release },
    });
    const open = vi.fn(async () => {});
    const api = {
      server: { getConfig: async () => ({ availableEditors: [editor] }) },
      shell: { openInEditor: open },
    } as unknown as NativeApi;
    for (let i = 0; i < 256; i++) await openInPreferredEditor(api, "/repo/report.json");
    expect(open).toHaveBeenCalledTimes(256);
    expect(release).toHaveBeenCalledTimes(256);
    expect(pending.size).toBe(0);
  },
);

it.each(["configuration", "no-editors", "launch"])(
  "releases native authorization after a %s failure",
  async (failure) => {
    const release = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("window", {
      desktopBridge: {
        prepareEditorOpen: vi.fn().mockResolvedValue("unused-token"),
        releaseEditorOpen: release,
      },
    });
    const getConfig = vi.fn().mockResolvedValue({
      availableEditors: failure === "no-editors" ? [] : ["vscode"],
    });
    const open = vi.fn().mockResolvedValue(undefined);
    if (failure === "configuration") getConfig.mockRejectedValue(new Error("Disconnected"));
    if (failure === "launch") open.mockRejectedValue(new Error("Cannot launch editor"));
    const api = { server: { getConfig }, shell: { openInEditor: open } } as unknown as NativeApi;
    await expect(openInPreferredEditor(api, "/repo/report.json")).rejects.toThrow();
    expect(release).toHaveBeenCalledWith("unused-token");
  },
);
