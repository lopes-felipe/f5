import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as Path from "node:path";
import type { IpcMain, IpcMainInvokeEvent } from "electron";
import { afterEach, expect, it, vi } from "vitest";
import {
  assertFileActionCaller,
  registerDesktopFileActions,
  vscodeFileUrl,
  macRevealFailureMessage,
  macRevealLaunch,
} from "./fileActions";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture() {
  const root = await mkdtemp(Path.join(tmpdir(), "f5-native-files-"));
  roots.push(root);
  const file = Path.join(root, "sample #1%.json");
  await writeFile(file, "{}");
  const handlers = new Map<string, Parameters<IpcMain["handle"]>[1]>();
  const ipc: Pick<IpcMain, "handle" | "removeHandler"> = {
    handle(channel, handler) {
      handlers.set(channel, handler);
    },
    removeHandler(channel) {
      handlers.delete(channel);
    },
  };
  const actions = {
    assertCaller: vi.fn((_event: IpcMainInvokeEvent) => {}),
    openExternal: vi.fn(async (_url: string) => {}),
    revealFile: vi.fn(async (_path: string) => {}),
  };
  const authority = registerDesktopFileActions(ipc, actions);
  return {
    file,
    canonical: await realpath(file),
    actions,
    authority,
    invoke: (
      channel: string,
      path: string | undefined,
      trusted: unknown = true,
      authorization?: string,
    ) =>
      handlers.get(channel)!(
        { sender: { id: 1 } } as IpcMainInvokeEvent,
        path,
        trusted,
        authorization,
      ),
  };
}

it("opens VS Code through its native file URL, preserving positions and escaping filenames", async () => {
  const f = await fixture();
  await f.invoke("desktop:open-in-vscode", `${f.file}:42:7`);
  expect(f.actions.openExternal).toHaveBeenCalledWith(
    `vscode://file/${f.canonical.replaceAll("\\", "/").replace(/^\//u, "").replaceAll("%", "%25").replaceAll(" ", "%20").replaceAll("#", "%23")}:42:7`,
  );
});

it("reveals the canonical file using one native operation", async () => {
  const f = await fixture();
  await f.invoke("desktop:reveal-file", f.file);
  expect(f.actions.revealFile).toHaveBeenCalledWith(f.canonical);
});

it("reveals on macOS through LaunchServices with the path as its own argument", () => {
  const path = '/tmp/file "quoted"; $(x).json';
  expect(macRevealLaunch(path)).toEqual({ file: "/usr/bin/open", args: ["-R", path] });
  expect(() => macRevealLaunch("-a Terminal")).toThrow("absolute path");
  expect(() => macRevealLaunch("relative.json")).toThrow("absolute path");
});

it("reports open's first stderr line instead of the command dump", () => {
  const dump = "Command failed: /usr/bin/open -R /x";
  expect(
    macRevealFailureMessage(
      Object.assign(new Error(dump), {
        code: 1,
        stderr: "\nThe file /x does not exist.\nmore detail\n",
      }),
    ),
  ).toBe("The file /x does not exist.");
  expect(
    macRevealFailureMessage(
      Object.assign(new Error(dump), { killed: true, signal: "SIGTERM", stderr: "" }),
    ),
  ).toBe("Finder did not respond within 5 seconds.");
  expect(macRevealFailureMessage(Object.assign(new Error(dump), { code: 1, stderr: "" }))).toBe(
    "open -R exited with code 1.",
  );
  expect(macRevealFailureMessage(new Error("spawn EACCES"))).toBe("spawn EACCES");
});

it.each(["desktop:reveal-file", "desktop:open-in-vscode"])(
  "rejects missing files, relative paths, and absent gestures for %s",
  async (channel) => {
    const f = await fixture();
    if (channel === "desktop:reveal-file")
      await expect(f.invoke(channel, f.file + ".missing")).rejects.toThrow(
        `File not found: ${f.file}.missing`,
      );
    await expect(f.invoke(channel, "relative.json")).rejects.toThrow("absolute path");
    await expect(f.invoke(channel, f.file, false)).rejects.toThrow("user gesture");
    expect(f.actions.openExternal).not.toHaveBeenCalled();
    expect(f.actions.revealFile).not.toHaveBeenCalled();
  },
);

it("propagates native launch and Finder activation errors", async () => {
  const f = await fixture();
  f.actions.openExternal.mockRejectedValue(new Error("VS Code is not installed"));
  await expect(f.invoke("desktop:open-in-vscode", f.file)).rejects.toThrow(
    "VS Code is not installed",
  );
  f.actions.revealFile.mockRejectedValue(new Error("Cannot activate Finder"));
  await expect(f.invoke("desktop:reveal-file", f.file)).rejects.toThrow("Cannot activate Finder");
});

it("builds Windows VS Code file URLs without treating drive letters as a protocol", () => {
  expect(vscodeFileUrl("C:\\My Files\\file.ts:8:2")).toBe(
    "vscode://file/C:/My%20Files/file.ts:8:2",
  );
});

it.each([{ registered: false }, { mainFrame: false }, { origin: "https://untrusted.invalid" }])(
  "rejects unauthorized desktop file actions: %j",
  (override) => {
    expect(() =>
      assertFileActionCaller({
        registered: true,
        mainFrame: true,
        origin: "f5://app",
        expectedOrigin: "f5://app",
        ...override,
      }),
    ).toThrow();
  },
);

it("opens a not-yet-created editor file using its canonical existing parent", async () => {
  const f = await fixture();
  await f.invoke("desktop:open-in-vscode", f.file + ".missing:2:1");
  expect(f.actions.openExternal).toHaveBeenCalledWith(vscodeFileUrl(f.canonical + ".missing:2:1"));
});
it("carries a native context-menu selection through a delayed preferred-editor handoff", async () => {
  const f = await fixture();
  f.authority.nativeMenuSelected(1, f.file);
  const token = (await f.invoke("desktop:prepare-editor-open", f.file, false)) as string;
  await f.invoke("desktop:open-in-vscode", f.file, false, token);
  expect(f.actions.openExternal).toHaveBeenCalledOnce();
  await expect(f.invoke("desktop:open-in-vscode", f.file, false, token)).rejects.toThrow(
    "authorization",
  );
});

it("releases editor grants through IPC when the preferred editor uses another transport", async () => {
  const f = await fixture();
  for (let i = 0; i < 256; i++) {
    const token = (await f.invoke("desktop:prepare-editor-open", f.file)) as string;
    await f.invoke("desktop:release-editor-open", token, false);
  }
  const token = (await f.invoke("desktop:prepare-editor-open", f.file)) as string;
  await f.invoke("desktop:open-in-vscode", f.file, false, token);
  expect(f.actions.openExternal).toHaveBeenCalledOnce();
});
