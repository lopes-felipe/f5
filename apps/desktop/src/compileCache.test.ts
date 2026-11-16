import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

it("enables caching before the main bundle and honors Node's opt-out", () => {
  const directory = mkdtempSync(join(tmpdir(), "f5-cache-boot-"));
  try {
    const source = fileURLToPath(new URL("./compileCache.ts", import.meta.url));
    execFileSync(
      "bun",
      [
        "build",
        source,
        "--target=node",
        "--format=cjs",
        "--outfile",
        join(directory, "compileCache.js"),
      ],
      { stdio: "pipe" },
    );
    writeFileSync(
      join(directory, "boot.js"),
      readFileSync(fileURLToPath(new URL("./boot.ts", import.meta.url))),
    );
    writeFileSync(
      join(directory, "main.js"),
      'console.log(require("node:module").getCompileCacheDir() ? "cached" : "uncached");',
    );
    for (const mode of ["enabled", "disabled", "appimage"]) {
      const output = execFileSync(process.execPath, [join(directory, "boot.js")], {
        encoding: "utf8",
        env: {
          PATH: process.env.PATH,
          HOME: process.env.HOME,
          XDG_CACHE_HOME: directory,
          TMPDIR: directory,
          ...(mode === "disabled" ? { NODE_DISABLE_COMPILE_CACHE: "1" } : {}),
          APPIMAGE: mode === "appimage" ? "/tmp/F5.AppImage" : "",
        },
      });
      expect(output.trim()).toBe(mode === "enabled" ? "cached" : "uncached");
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
