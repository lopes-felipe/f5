import * as FS from "node:fs/promises";
import * as OS from "node:os";
import * as Path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { githubTerminalStartup, prepareGithubShellStartup } from "./githubShellStartup";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

it.each([
  ["darwin", "ipc", true],
  ["darwin", "", false],
  ["linux", "ipc", false],
  ["win32", "ipc", false],
] as const)(
  "restores the browser launcher only in desktop macOS shells (%s, %s)",
  async (platform, host, enabled) => {
    vi.stubEnv("F5_DESKTOP_COMPUTER_HOST", host);
    vi.stubGlobal(
      "process",
      new Proxy(process, {
        get: (target, key) => (key === "platform" ? platform : Reflect.get(target, key)),
      }),
    );
    const root = await FS.mkdtemp(Path.join(OS.tmpdir(), "f5-browser-shell-"));
    try {
      await prepareGithubShellStartup(root);
      for (const file of [
        ".zshenv",
        ".zprofile",
        ".zshrc",
        ".zlogin",
        ".zlogout",
        "bash-env",
        "bashrc",
      ]) {
        const source = await FS.readFile(Path.join(root, "github-shells", file), "utf8");
        expect(source.includes("export BROWSER=")).toBe(enabled);
        expect(source.includes("browser-bin")).toBe(enabled);
        if (enabled) {
          expect(source).toContain(Path.join(root, "browser-bin", "f5-open-url"));
          expect(source.indexOf("github-bin")).toBeLessThan(source.indexOf("browser-bin"));
        }
      }
      const fish = githubTerminalStartup("fish", [], {}, root).args.join(" ");
      expect(fish.includes("set -gx BROWSER")).toBe(enabled);
      for (const shell of ["powershell", "pwsh"]) {
        const command = githubTerminalStartup(shell, [], {}, root).args.join(" ");
        expect(command.includes("$env:BROWSER")).toBe(enabled);
        expect(command.includes("browser-bin")).toBe(enabled);
        if (enabled)
          expect(command.indexOf("github-bin")).toBeLessThan(command.indexOf("browser-bin"));
      }
    } finally {
      await FS.rm(root, { recursive: true, force: true });
    }
  },
);
