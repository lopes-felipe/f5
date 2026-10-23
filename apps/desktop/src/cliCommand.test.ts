import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { promisify } from "node:util";
import { afterEach, expect, it } from "vitest";
import { createDesktopCliInstaller } from "./cliCommand";
const execute = promisify(execFile);
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "f5-cli-"));
  roots.push(root);
  const executable = path.join(root, "F5 app's runtime");
  const entry = path.join(root, "server's entry.mjs");
  await fs.writeFile(executable, '#!/bin/sh\nprintf "%s\\n" "$ELECTRON_RUN_AS_NODE" "$@"\n', {
    mode: 0o755,
  });
  await fs.writeFile(entry, "fixture");
  const systemBin = path.join(root, "usr-local-bin"),
    home = path.join(root, "home");
  const localBin = path.join(home, ".local/bin");
  const launcherDirectory = path.join(root, "userdata/cli");
  let searchPath = [systemBin, localBin].join(path.delimiter);
  const options = {
    executable,
    entry,
    launcherDirectory,
    home,
    systemBin,
    platform: "darwin" as const,
    path: () => searchPath,
  };
  return {
    root,
    options,
    entry,
    localBin,
    systemBin,
    launcherDirectory,
    installer: createDesktopCliInstaller(options),
    path: (next: string) => {
      searchPath = next;
    },
  };
}
// The launcher is a /bin/sh script; Windows cannot execute it and never installs it.
const itRunsLauncher = it.skipIf(process.platform === "win32");
itRunsLauncher(
  "installs both commands idempotently, serializes calls and preserves arbitrary arguments",
  async () => {
    const f = await fixture();
    expect((await f.installer.state()).installedPaths).toEqual({ f5: null, t3: null });
    const [one, two] = await Promise.all([f.installer.install(), f.installer.install()]);
    expect(one).toEqual(two);
    expect(one.onPath).toBe(true);
    const command = path.join(f.systemBin, "f5");
    expect(await fs.readlink(command)).toBe(path.join(f.launcherDirectory, "f5"));
    expect(
      (await execute(command, ["a b", "$(echo unexpected)", "c'd", "café"])).stdout.split("\n"),
    ).toEqual(["1", f.entry, "a b", "$(echo unexpected)", "c'd", "café", ""]);
  },
);
it("falls back to the user's local bin without privilege escalation", async () => {
  const f = await fixture();
  await fs.writeFile(f.systemBin, "occupied");
  const result = await f.installer.install();
  expect(result.installedPaths).toEqual({
    f5: path.join(f.localBin, "f5"),
    t3: path.join(f.localBin, "t3"),
  });
  expect(result.onPath).toBe(true);
});
it("refuses to install behind another executable anywhere on PATH", async () => {
  const f = await fixture();
  const other = path.join(f.root, "other");
  await fs.mkdir(other);
  const theirs = path.join(other, "t3");
  await fs.writeFile(theirs, "#!/bin/sh\n", { mode: 0o755 });
  f.path([other, f.localBin].join(path.delimiter));
  expect((await f.installer.state()).shadowedBy).toBe(theirs);
  await expect(f.installer.install()).rejects.toThrow("runs first on PATH");
  await expect(fs.lstat(path.join(f.localBin, "f5"))).rejects.toMatchObject({ code: "ENOENT" });
  expect(await fs.readFile(theirs, "utf8")).toBe("#!/bin/sh\n");
});
it("never replaces foreign files or dangling symlinks", async () => {
  const f = await fixture();
  await fs.mkdir(f.systemBin);
  await fs.mkdir(f.localBin, { recursive: true });
  for (const directory of [f.systemBin, f.localBin])
    await fs.symlink(path.join(f.root, "gone"), path.join(directory, "t3"));
  await expect(f.installer.install()).rejects.toThrow("without replacing another file");
  for (const directory of [f.systemBin, f.localBin])
    expect(await fs.readlink(path.join(directory, "t3"))).toBe(path.join(f.root, "gone"));
});
it("reports the installed location when it is not on PATH", async () => {
  const f = await fixture();
  f.path("");
  const result = await f.installer.install();
  expect(result.onPath).toBe(false);
  expect(result.installedPaths.f5).toBe(path.join(f.systemBin, "f5"));
});
it("offers no CLI when the app runs from a temporary location, as an AppImage does", async () => {
  const f = await fixture();
  const appImage = createDesktopCliInstaller({
    ...f.options,
    platform: "linux",
    transientPaths: true,
  });
  expect((await appImage.state()).supported).toBe(false);
  await expect(appImage.install()).rejects.toThrow("AppImage");
});
itRunsLauncher(
  "stops reporting the commands as installed once the app they run has moved",
  async () => {
    const f = await fixture();
    await f.installer.install();
    const moved = path.join(f.root, "moved runtime");
    await fs.rename(f.options.executable, moved);
    const relocated = createDesktopCliInstaller({ ...f.options, executable: moved });
    const stale = await relocated.state();
    expect(stale).toMatchObject({ onPath: false, installedPaths: { f5: null, t3: null } });
    expect(stale.shadowedBy).toBeUndefined();

    const repaired = await relocated.install();
    expect(repaired).toMatchObject({
      onPath: true,
      installedPaths: { f5: path.join(f.systemBin, "f5") },
    });
    expect((await execute(path.join(f.systemBin, "f5"), ["x"])).stdout.split("\n")).toEqual([
      "1",
      f.entry,
      "x",
      "",
    ]);
  },
);
it("refuses an unowned launcher and disables symlink installation on Windows", async () => {
  const f = await fixture();
  await fs.mkdir(f.launcherDirectory, { recursive: true });
  const launcher = path.join(f.launcherDirectory, "f5");
  await fs.writeFile(launcher, "foreign");
  await expect(f.installer.install()).rejects.toThrow("occupied by another file");
  expect(await fs.readFile(launcher, "utf8")).toBe("foreign");
  const windows = createDesktopCliInstaller({ ...f.options, platform: "win32" });
  expect((await windows.state()).supported).toBe(false);
  await expect(windows.install()).rejects.toThrow("macOS and Linux");
});
