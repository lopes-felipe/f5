import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { tarExecutable } from "@t3tools/shared/cliRelease";
import { stageCliSmokeArchiveTools } from "./cli-smoke-tools.ts";

const exec = promisify(execFile);

it("installs compressed archives with an isolated PATH that excludes runtimes and providers", async () => {
  const root = await mkdtemp(join(tmpdir(), "f5-smoke-tools-"));
  try {
    const bin = join(root, "path");
    const output = join(root, "extracted");
    await mkdir(bin);
    await mkdir(output);
    await stageCliSmokeArchiveTools(bin);
    const env = {
      ...Object.fromEntries(
        Object.entries(process.env).filter(([name]) => name.toUpperCase() !== "PATH"),
      ),
      PATH: bin,
    };
    const options = { env, cwd: root, timeout: 10_000 };
    await writeFile(join(root, "payload.txt"), "standalone CLI archive");
    const archive = join(root, "candidate.tar.gz");
    await exec(tarExecutable(), ["-czf", archive, "-C", root, "payload.txt"], options);
    await exec(tarExecutable(), ["-xzf", archive, "-C", output], options);
    expect(await readFile(join(output, "payload.txt"), "utf8")).toBe("standalone CLI archive");
    for (const program of ["node", "bun", "claude", "codex"])
      await expect(exec(program, ["--version"], options)).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);
