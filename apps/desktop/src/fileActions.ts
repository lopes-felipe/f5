import * as Path from "node:path";
import { realpath, stat } from "node:fs/promises";
import type { IpcMain, IpcMainInvokeEvent } from "electron";
import { FileActionAuthorizations } from "./fileActionAuthorization";

export function assertFileActionCaller(input: {
  registered: boolean;
  mainFrame: boolean;
  origin: string;
  expectedOrigin: string;
}): void {
  if (!input.registered || !input.mainFrame || input.origin !== input.expectedOrigin) {
    throw new Error("File actions require an F5 application main frame.");
  }
}

export function vscodeFileUrl(targetPath: string): string {
  const url = new URL("vscode://file/");
  url.pathname = targetPath
    .replaceAll("\\", "/")
    .replace(/^(?!\/)/u, "/")
    .split("/")
    .map((segment) => encodeURIComponent(segment).replaceAll("%3A", ":"))
    .join("/");
  return url.href;
}

async function resolveLocalTarget(raw: unknown, withPosition: boolean) {
  if (typeof raw !== "string" || raw.length > 32768 || raw.includes("\0")) {
    throw new Error("Invalid local file path.");
  }
  const match = withPosition ? /^(.*?)(:\d+(?::\d+)?)$/u.exec(raw) : null;
  const filePath = match?.[1] ?? raw;
  if (!Path.isAbsolute(filePath)) throw new Error("A local absolute path is required.");
  let absolutePath: string;
  try {
    absolutePath = await realpath(filePath);
  } catch (error) {
    if (!withPosition || (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const parent = await realpath(Path.dirname(filePath));
    if (!(await stat(parent)).isDirectory()) throw new Error("File parent is not a directory.");
    return {
      absolutePath: Path.join(parent, Path.basename(filePath)),
      directory: false,
      position: match?.[2] ?? "",
    };
  }
  const entry = await stat(absolutePath);
  if (!entry.isFile() && !entry.isDirectory()) throw new Error("Unsupported filesystem entry.");
  return { absolutePath, directory: entry.isDirectory(), position: match?.[2] ?? "" };
}

export function registerDesktopFileActions(
  ipc: Pick<IpcMain, "handle" | "removeHandler">,
  actions: {
    assertCaller: (event: IpcMainInvokeEvent) => void;
    openExternal: (url: string) => Promise<void>;
    revealFile: (filePath: string) => Promise<void>;
  },
): { nativeMenuSelected: (owner: number, target: string) => void } {
  const authorizations = new FileActionAuthorizations();
  ipc.removeHandler("desktop:release-editor-open");
  ipc.handle("desktop:release-editor-open", (event, authorization: unknown) => {
    actions.assertCaller(event);
    authorizations.release(event.sender.id, authorization);
  });
  ipc.removeHandler("desktop:prepare-editor-open");
  ipc.handle("desktop:prepare-editor-open", (event, target: unknown, trusted: unknown) => {
    actions.assertCaller(event);
    if (
      target !== undefined &&
      (typeof target !== "string" ||
        !Path.isAbsolute(target) ||
        target.includes("\0") ||
        target.length > 32768)
    )
      throw new Error("Invalid local editor target.");
    return authorizations.prepare(event.sender.id, target as string | undefined, trusted === true);
  });
  ipc.removeHandler("desktop:open-in-vscode");
  ipc.handle(
    "desktop:open-in-vscode",
    async (event, raw: unknown, trusted: unknown, authorization: unknown) => {
      actions.assertCaller(event);
      authorizations.consume(event.sender.id, String(raw), trusted === true, authorization);
      const target = await resolveLocalTarget(raw, true);
      await actions.openExternal(
        vscodeFileUrl(target.absolutePath + (target.directory ? "/" : target.position)),
      );
    },
  );
  ipc.removeHandler("desktop:reveal-file");
  ipc.handle("desktop:reveal-file", async (event, raw: unknown, trusted: unknown) => {
    actions.assertCaller(event);
    authorizations.consume(event.sender.id, String(raw), trusted === true);
    const target = await resolveLocalTarget(raw, false);
    await actions.revealFile(target.absolutePath);
  });
  return {
    nativeMenuSelected(owner, target) {
      if (Path.isAbsolute(target) && target.length <= 32768 && !target.includes("\0"))
        authorizations.nativeMenuSelected(owner, target);
    },
  };
}

/** Finder processes reveal and activate in one ordered request; the path is an argv value. */
export function finderRevealArgs(filePath: string): string[] {
  return [
    "-e",
    'on run argv\n tell application "Finder"\n  reveal POSIX file (item 1 of argv)\n  activate\n end tell\nend run',
    "--",
    filePath,
  ];
}
