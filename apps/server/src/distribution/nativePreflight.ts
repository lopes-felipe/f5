// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalTimers:off
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { createRequire } from "node:module";
import { loadFff } from "./runtimeModules";
export async function nativePreflight(): Promise<void> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "f5-native-preflight-"));
  try {
    await fs.writeFile(path.join(directory, "fixture.txt"), "F5 standalone native search\n");
    const fff = await loadFff();
    const result = fff.FileFinder.create({ basePath: directory, disableWatch: true });
    if (!result.ok) throw new Error("Native search initialization failed.");
    try {
      if (!(await result.value.waitForScan(5000))) throw new Error("Native search scan timed out.");
      const search = result.value.fileSearch("fixture.txt");
      if (!search.ok || !search.value.items.length) throw new Error("Native file search failed.");
    } finally {
      result.value.destroy();
    }
    const pty = createRequire(process.execPath)("node-pty") as typeof import("node-pty");
    const shell =
      process.platform === "win32"
        ? (process.env.ComSpec ??
          path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "cmd.exe"))
        : "/bin/sh";
    const child = pty.spawn(
      shell,
      process.platform === "win32"
        ? ["/d", "/c", "echo f5-pty-ready"]
        : ["-c", "printf f5-pty-ready"],
      { cwd: directory, env: process.env, name: "xterm" },
    );
    await new Promise<void>((resolve, reject) => {
      let output = "";
      const timer = setTimeout(() => {
        child.kill();
        reject(new Error("Native PTY timed out."));
      }, 5000);
      child.onData((data) => {
        output += data;
      });
      child.onExit(({ exitCode }) => {
        clearTimeout(timer);
        if (exitCode === 0 && output.includes("f5-pty-ready")) resolve();
        else reject(new Error("Native PTY startup failed."));
      });
    });
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}
