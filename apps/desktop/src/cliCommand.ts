import * as fs from "node:fs/promises";
import * as path from "node:path";
import { constants } from "node:fs";
import { randomUUID } from "node:crypto";
import type { DesktopCliCommandState } from "@t3tools/contracts";

const COMMANDS = ["f5", "t3"] as const;
const MARKER = "# F5 desktop CLI launcher v1\n";
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
const missing = (error: unknown) =>
  ["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "");

/** Explicit installation only. No shell startup files, privilege escalation or foreign replacement. */
export function createDesktopCliInstaller(options: {
  executable: string;
  entry: string;
  launcherDirectory: string;
  home: string;
  platform?: NodeJS.Platform;
  path?: () => string;
  systemBin?: string;
  /**
   * The executable and entry move on every launch, as under an AppImage, which runs from a
   * temporary mount. A launcher would break as soon as F5 quits, so none is offered.
   */
  transientPaths?: boolean;
}) {
  const supported = (options.platform ?? process.platform) !== "win32" && !options.transientPaths;
  const candidates = [options.systemBin ?? "/usr/local/bin", path.join(options.home, ".local/bin")];
  const launcher = path.join(options.launcherDirectory, "f5");
  const content = `#!/bin/sh\n${MARKER}ELECTRON_RUN_AS_NODE=1 exec ${quote(options.executable)} ${quote(options.entry)} "$@"\n`;
  let flight = Promise.resolve();
  const ownLink = async (file: string) => {
    try {
      const info = await fs.lstat(file);
      return (
        info.isSymbolicLink() &&
        path.resolve(path.dirname(file), await fs.readlink(file)) === launcher
      );
    } catch (error) {
      if (
        missing(error) ||
        ["EACCES", "EPERM"].includes((error as NodeJS.ErrnoException).code ?? "")
      )
        return false;
      throw error;
    }
  };
  const firstOnPath = async (command: string) => {
    for (const directory of (options.path?.() ?? process.env.PATH ?? "").split(path.delimiter)) {
      // Empty entries mean cwd; inspect them too before offering an installation.
      const file = path.resolve(directory || ".", command);
      try {
        await fs.access(file, constants.X_OK);
        if ((await fs.stat(file)).isFile()) return file;
      } catch (error) {
        if (!missing(error) && (error as NodeJS.ErrnoException).code !== "EACCES") throw error;
      }
    }
    return null;
  };
  // A launcher written by an earlier install can name an app that has since moved; the commands
  // count as installed only while it runs this one, so installing again repairs it.
  const launcherCurrent = async () => {
    try {
      return (await fs.readFile(launcher, "utf8")) === content;
    } catch (error) {
      if (missing(error)) return false;
      throw error;
    }
  };
  const state = async (): Promise<DesktopCliCommandState> => {
    const installedPaths: Record<"f5" | "t3", string | null> = { f5: null, t3: null };
    if (!supported) return { supported, installedPaths, onPath: false };
    let shadowedBy: string | undefined;
    let onPath = true;
    const current = await launcherCurrent();
    for (const command of COMMANDS) {
      for (const directory of candidates)
        if (current && (await ownLink(path.join(directory, command)))) {
          installedPaths[command] = path.join(directory, command);
          break;
        }
      const first = await firstOnPath(command);
      const ours = first !== null && (await ownLink(first));
      if (!current || !ours) onPath = false;
      if (first && !ours) shadowedBy ??= first;
    }
    return { supported, installedPaths, onPath, ...(shadowedBy ? { shadowedBy } : {}) };
  };
  const publishLauncher = async () => {
    await fs.mkdir(options.launcherDirectory, { recursive: true, mode: 0o700 });
    try {
      const existing = await fs.lstat(launcher);
      if (!existing.isFile() || existing.size > 16 * 1024)
        throw new Error("The CLI launcher path is occupied by another file.");
      const previous = await fs.readFile(launcher, "utf8");
      if (!previous.startsWith(`#!/bin/sh\n${MARKER}`))
        throw new Error("The CLI launcher path is occupied by another file.");
      if (previous === content) return;
    } catch (error) {
      if (!missing(error)) throw error;
    }
    const temporary = path.join(options.launcherDirectory, `.f5-${randomUUID()}`);
    try {
      await fs.writeFile(temporary, content, { flag: "wx", mode: 0o755 });
      await fs.rename(temporary, launcher);
    } finally {
      await fs.unlink(temporary).catch((error) => {
        if (!missing(error)) throw error;
      });
    }
  };
  const performInstall = async () => {
    if (!supported)
      throw new Error(
        options.transientPaths
          ? "The CLI cannot be installed from an AppImage, which runs from a temporary location."
          : "Desktop CLI symlinks are available on macOS and Linux.",
      );
    const current = await state();
    if (current.shadowedBy)
      throw new Error(
        `Another command at ${current.shadowedBy} runs first on PATH. Remove it or adjust PATH before installing F5's commands.`,
      );
    await fs.access(options.entry, constants.R_OK);
    await fs.access(options.executable, constants.X_OK);
    await publishLauncher();
    for (const command of COMMANDS) {
      if (current.installedPaths[command]) continue;
      let installed = false;
      for (const directory of candidates) {
        try {
          await fs.mkdir(directory, { recursive: true });
          // symlink is exclusive even for dangling links and races; never replace a destination.
          await fs.symlink(launcher, path.join(directory, command));
          installed = true;
          break;
        } catch (error) {
          if (await ownLink(path.join(directory, command))) {
            installed = true;
            break;
          }
          if (
            !["EACCES", "EPERM", "EROFS", "EEXIST", "ENOTDIR"].includes(
              (error as NodeJS.ErrnoException).code ?? "",
            )
          )
            throw error;
        }
      }
      if (!installed)
        throw new Error(
          `Could not install ${command} without replacing another file. Choose a writable directory or free ~/.local/bin/${command}.`,
        );
    }
    return state();
  };
  return {
    state,
    install: () => {
      const next = flight.then(performInstall);
      flight = next.then(
        () => undefined,
        () => undefined,
      );
      return next;
    },
  };
}
