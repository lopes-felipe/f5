import { expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { atomicWrite, readPreferences } from "./preferences";
it("defaults invalid data to opt-out and persists preferences atomically", async () => {
  const dir = await mkdtemp(join(tmpdir(), "f5-keep-awake-prefs-"));
  try {
    const path = join(dir, "preferences.json");
    expect(await readPreferences(path)).toEqual({ mode: "off", closedLid: false });
    await writeFile(path, '{"mode":"invalid","closedLid":true}');
    expect(await readPreferences(path)).toEqual({ mode: "off", closedLid: false });
    await atomicWrite(path, { mode: "agents", closedLid: true });
    expect(await readPreferences(path)).toEqual({ mode: "agents", closedLid: true });
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ mode: "agents", closedLid: true });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
