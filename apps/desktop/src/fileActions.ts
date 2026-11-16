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
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    if (!withPosition) throw new Error(`File not found: ${filePath}`);
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
): {
  nativeMenuSelected: (owner: number, target: string, action?: "editor" | "reveal") => void;
  clearNativeMenu: (owner: number) => void;
} {
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
    authorizations.consume(event.sender.id, String(raw), trusted === true, undefined, "reveal");
    const target = await resolveLocalTarget(raw, false);
    await actions.revealFile(target.absolutePath);
  });
  return {
    clearNativeMenu: (owner) => authorizations.clearNativeMenu(owner),
    nativeMenuSelected(owner, target, action) {
      if (Path.isAbsolute(target) && target.length <= 32768 && !target.includes("\0"))
        authorizations.nativeMenuSelected(owner, target, action);
    },
  };
}

/**
 * `open -R` asks LaunchServices to select the item in Finder and bring Finder
 * forward. It sends no Apple Events, so it needs no Automation permission, and
 * it fails with a readable message when the file is missing. A Finder
 * `reveal POSIX file (item 1 of argv)` script cannot work: inside a Finder
 * `tell` block a runtime `POSIX file` becomes a Finder object reference that
 * Finder cannot resolve (-1728).
 */
export function macRevealLaunch(filePath: string): { file: string; args: string[] } {
  // `open` would read a leading "-" as an option; callers pass canonical absolute paths.
  if (!Path.isAbsolute(filePath)) throw new Error("Reveal needs an absolute path.");
  return { file: "/usr/bin/open", args: ["-R", filePath] };
}

export const MAC_REVEAL_TIMEOUT_MS = 5000;

/**
 * A one-line reason for a failed `execFile` of `macRevealLaunch`: `open`'s own
 * first stderr line (e.g. `The file /x does not exist.`), never the
 * `Command failed: …` dump.
 */
export function macRevealFailureMessage(
  error: Error & { readonly stderr?: unknown; readonly killed?: boolean; readonly code?: unknown },
): string {
  if (error.killed) {
    return `Finder did not respond within ${MAC_REVEAL_TIMEOUT_MS / 1000} seconds.`;
  }
  const stderr = typeof error.stderr === "string" ? error.stderr : String(error.stderr ?? "");
  const firstLine = stderr
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .find(Boolean);
  if (firstLine) return firstLine;
  // A numeric code means `open` ran and failed silently; otherwise it is a spawn error.
  return typeof error.code === "number" ? `open -R exited with code ${error.code}.` : error.message;
}
