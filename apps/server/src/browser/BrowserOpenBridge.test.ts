import * as FS from "node:fs/promises";
import * as OS from "node:os";
import * as Path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { startBrowserOpenBridge } from "./BrowserOpenBridge";
import { browserOpenSocketPath } from "./BrowserOpenLauncher";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

it.skipIf(process.platform === "win32").each([
  ["darwin", "ipc", true],
  ["darwin", "", false],
  ["linux", "ipc", false],
  ["win32", "ipc", false],
] as const)(
  "starts the bridge only for desktop macOS (%s, %s)",
  async (platform, host, enabled) => {
    vi.stubEnv("F5_DESKTOP_COMPUTER_HOST", host);
    vi.stubGlobal(
      "process",
      new Proxy(process, {
        get: (target, key) => (key === "platform" ? platform : Reflect.get(target, key)),
      }),
    );
    const root = await FS.mkdtemp(Path.join(OS.tmpdir(), "f5-browser-bridge-"));
    const close = await startBrowserOpenBridge(root, { openExternalUrl: async () => "opened" });
    try {
      expect(await FS.readdir(root)).toEqual(
        enabled ? expect.arrayContaining(["browser-bin", "browser-open"]) : [],
      );
      if (enabled) expect((await FS.stat(browserOpenSocketPath(root))).isSocket()).toBe(true);
    } finally {
      await close();
      await FS.rm(root, { recursive: true, force: true });
    }
  },
);

it.skipIf(process.platform === "win32")(
  "degrades to manual copy when the socket path is blocked",
  async () => {
    const root = await FS.mkdtemp(Path.join(OS.tmpdir(), "f5-browser-bridge-blocked-"));
    const socketPath = browserOpenSocketPath(root);
    const warn = vi.fn();
    try {
      await FS.mkdir(Path.dirname(socketPath), { recursive: true });
      await FS.writeFile(socketPath, "keep");
      const close = await startBrowserOpenBridge(
        root,
        { openExternalUrl: async () => "opened" },
        true,
        warn,
      );
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining("listener unavailable"),
        expect.any(Error),
      );
      expect(await FS.readFile(socketPath, "utf8")).toBe("keep");
      const source = await FS.readFile(Path.join(root, "browser-bin", "open-url.cjs"), "utf8");
      expect(source).toContain("const socketPath = null;");
      await close();
    } finally {
      await FS.rm(socketPath, { force: true });
      await FS.rm(root, { recursive: true, force: true });
    }
  },
);

it("contains launcher write failures as well as listener setup failures", async () => {
  const root = await FS.mkdtemp(Path.join(OS.tmpdir(), "f5-browser-bridge-write-"));
  const blocked = Path.join(root, "file");
  const warn = vi.fn();
  try {
    await FS.writeFile(blocked, "keep");
    const close = await startBrowserOpenBridge(
      blocked,
      { openExternalUrl: async () => "opened" },
      true,
      warn,
    );
    expect(warn).toHaveBeenCalledTimes(2);
    expect(await FS.readFile(blocked, "utf8")).toBe("keep");
    await close();
  } finally {
    await FS.rm(root, { recursive: true, force: true });
  }
});
