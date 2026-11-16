import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { isDebPackage } from "./linuxPackage";

it("recognizes only Linux Debian markers and tolerates missing files", async () => {
  const directory = await mkdtemp(join(tmpdir(), "f5-package-"));
  try {
    expect(await isDebPackage("linux", directory)).toBe(false);
    await writeFile(join(directory, "package-type"), "deb\n");
    expect(await isDebPackage("linux", directory)).toBe(true);
    expect(await isDebPackage("darwin", directory)).toBe(false);
    await writeFile(join(directory, "package-type"), "rpm\n");
    expect(await isDebPackage("linux", directory)).toBe(false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
