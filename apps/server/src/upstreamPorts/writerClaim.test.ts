import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ensureWriterClaim, readWriterClaim, takeOverWriterClaim } from "./writerClaim.ts";

const a = { profileId: "a", stateDir: "/state/a", hostname: "host" };
const b = { profileId: "b", stateDir: "/state/b", hostname: "host" };
const NOW = "2026-10-23T00:00:00.000Z";

describe("writer claim", () => {
  let dir: string;
  let file: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "f5-writer-claim-"));
    file = path.join(dir, "claims", "repo.json");
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));

  it("lets exactly one of two racing profiles claim, and leaves no temp files", async () => {
    const results = await Promise.all([
      ensureWriterClaim(file, a, NOW),
      ensureWriterClaim(file, b, NOW),
    ]);
    expect(results.toSorted()).toEqual([false, true]);
    const claim = await readWriterClaim(file);
    expect(claim?.profileId).toBe(results[0] ? "a" : "b");
    expect(await readdir(path.dirname(file))).toEqual(["repo.json"]);
  });

  it("treats an empty or corrupt claim as unclaimed and replaces it", async () => {
    await mkdir(path.dirname(file), { recursive: true });
    for (const text of ["", '{"profileId":', "null"]) {
      await writeFile(file, text);
      expect(await readWriterClaim(file)).toBeNull();
      expect(await ensureWriterClaim(file, a, NOW)).toBe(true);
      expect(JSON.parse(await readFile(file, "utf8")).profileId).toBe("a");
      expect(await ensureWriterClaim(file, b, NOW)).toBe(false);
    }
    await takeOverWriterClaim(file, b, NOW);
    expect((await readWriterClaim(file))?.profileId).toBe("b");
  });

  it("rejects unreadable claims instead of reporting them unclaimed", async () => {
    await mkdir(file, { recursive: true });
    await expect(readWriterClaim(file)).rejects.toThrow();
    await expect(ensureWriterClaim(file, a, NOW)).rejects.toThrow();
  });
});
