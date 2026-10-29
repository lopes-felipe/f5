import * as FS from "node:fs/promises";
import * as OS from "node:os";
import * as Path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { githubTerminalStartup, prepareGithubShellStartup } from "./githubShellStartup";

afterEach(() => vi.unstubAllGlobals());

it.each(["darwin", "linux"] as const)(
  "restores the macOS browser launcher after user shell startup (%s)",
  async (platform) => {
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
        expect(source.includes("export BROWSER=")).toBe(platform === "darwin");
        expect(source.includes("browser-bin")).toBe(platform === "darwin");
        if (platform === "darwin") {
          expect(source).toContain(Path.join(root, "browser-bin", "f5-open-url"));
          expect(source.indexOf("github-bin")).toBeLessThan(source.indexOf("browser-bin"));
        }
      }
      const fish = githubTerminalStartup("fish", [], {}, root).args.join(" ");
      expect(fish.includes("set -gx BROWSER")).toBe(platform === "darwin");
    } finally {
      await FS.rm(root, { recursive: true, force: true });
    }
  },
);
