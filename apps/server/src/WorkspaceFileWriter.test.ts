import { afterEach, expect, it } from "vitest";
import * as FS from "node:fs/promises";
import * as Path from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { writeWorkspaceFile } from "./WorkspaceFileWriter";
const directories: string[] = [];
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
async function fixture() {
  const cwd = await FS.mkdtemp(Path.join(tmpdir(), "f5-atomic-write-"));
  directories.push(cwd);
  return { cwd, locks: Path.join(cwd, "locks") };
}
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((dir) => FS.rm(dir, { recursive: true, force: true })),
  );
});
it("never overwrites an existing file when exporting an artifact", async () => {
  const { cwd, locks } = await fixture();
  await FS.writeFile(Path.join(cwd, "plan.md"), "original");
  expect(
    await writeWorkspaceFile(
      { cwd, relativePath: "plan.md", contents: "replacement", condition: { type: "create" } },
      locks,
    ),
  ).toEqual({ conflict: true, relativePath: "plan.md", currentContentSha256: hash("original") });
  expect(await FS.readFile(Path.join(cwd, "plan.md"), "utf8")).toBe("original");
});
it("serializes separate backend processes: exactly one create and one matching save win", async () => {
  const { cwd, locks } = await fixture();
  const run = promisify(execFile);
  const module = Path.resolve(import.meta.dirname, "WorkspaceFileWriter.ts");
  const write = async (
    text: string,
    condition: { type: "create" } | { type: "match"; contentSha256: string },
  ) => {
    const input = { cwd, relativePath: "race.txt", contents: text, condition };
    const { stdout } = await run("bun", [
      "--eval",
      `import { writeWorkspaceFile } from ${JSON.stringify(module)}; console.log(JSON.stringify(await writeWorkspaceFile(${JSON.stringify(input)}, ${JSON.stringify(locks)})));`,
    ]);
    return JSON.parse(stdout) as { conflict?: boolean; contentSha256?: string };
  };
  const creates = await Promise.all([
    write("one", { type: "create" }),
    write("two", { type: "create" }),
  ]);
  expect(creates.filter((result) => !result.conflict)).toHaveLength(1);
  const base = await FS.readFile(Path.join(cwd, "race.txt"), "utf8");
  const saves = await Promise.all([
    write("three", { type: "match", contentSha256: hash(base) }),
    write("four", { type: "match", contentSha256: hash(base) }),
  ]);
  expect(saves.filter((result) => !result.conflict)).toHaveLength(1);
  expect(["three", "four"]).toContain(await FS.readFile(Path.join(cwd, "race.txt"), "utf8"));
});
it("preserves permissions and rejects symlinks, binary content and path escapes", async () => {
  const { cwd, locks } = await fixture();
  await FS.writeFile(Path.join(cwd, "source"), "base", { mode: 0o640 });
  const originalMode = (await FS.stat(Path.join(cwd, "source"))).mode & 0o777;
  await writeWorkspaceFile(
    {
      cwd,
      relativePath: "source",
      contents: "next",
      condition: { type: "match", contentSha256: hash("base") },
    },
    locks,
  );
  expect((await FS.stat(Path.join(cwd, "source"))).mode & 0o777).toBe(originalMode);
  await FS.symlink(Path.join(cwd, "source"), Path.join(cwd, "link"));
  await expect(
    writeWorkspaceFile(
      { cwd, relativePath: "link", contents: "x", condition: { type: "create" } },
      locks,
    ),
  ).rejects.toThrow("symlinks");
  await expect(
    writeWorkspaceFile(
      { cwd, relativePath: "../outside", contents: "x", condition: { type: "create" } },
      locks,
    ),
  ).rejects.toThrow("within");
  await expect(
    writeWorkspaceFile(
      { cwd, relativePath: "binary", contents: "\0", condition: { type: "create" } },
      locks,
    ),
  ).rejects.toThrow("unsupported");
  expect((await FS.readdir(cwd)).filter((entry) => entry.startsWith(".f5-"))).toEqual([]);
});

it("does not overwrite an external creation between preparation and install", async () => {
  const { cwd, locks } = await fixture();
  const destination = Path.join(cwd, "external.txt");
  const result = await writeWorkspaceFile(
    { cwd, relativePath: "external.txt", contents: "F5 content", condition: { type: "create" } },
    locks,
    {
      link: async (source, target) => {
        await FS.writeFile(destination, "external writer", { flag: "wx" });
        await FS.link(source, target);
      },
    },
  );
  expect(result).toEqual({
    conflict: true,
    relativePath: "external.txt",
    currentContentSha256: hash("external writer"),
  });
  expect(await FS.readFile(destination, "utf8")).toBe("external writer");
});

it.each(["ENOTSUP", "ENOSPC"])(
  "cleans temporary files and never falls back to overwrite on %s",
  async (code) => {
    const { cwd, locks } = await fixture();
    await expect(
      writeWorkspaceFile(
        { cwd, relativePath: "no-link.txt", contents: "new", condition: { type: "create" } },
        locks,
        {
          link: async () => {
            throw Object.assign(new Error(code), { code });
          },
        },
      ),
    ).rejects.toThrow(code === "ENOTSUP" ? "unsupported" : "ENOSPC");
    expect(
      (await FS.readdir(cwd)).filter((name) => name.startsWith(".f5-") || name === "no-link.txt"),
    ).toEqual([]);
  },
);
