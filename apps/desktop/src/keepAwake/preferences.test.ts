import { expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { atomicWrite, readPreferences } from "./preferences";
it("defaults invalid data to opt-out and persists preferences atomically", async () => {
  const dir = await mkdtemp(join(tmpdir(), "f5-keep-awake-prefs-"));
  try {
    const path = join(dir, "preferences.json");
    const off = { mode: "off", closedLid: false, keepDisplayOn: false };
    expect(await readPreferences(path)).toEqual(off);
    await writeFile(path, '{"mode":"invalid","closedLid":true}');
    expect(await readPreferences(path)).toEqual(off);
    // Files written before keepDisplayOn existed stay valid and default to opt-out.
    await writeFile(path, '{"mode":"always","closedLid":true}');
    expect(await readPreferences(path)).toEqual({
      mode: "always",
      closedLid: true,
      keepDisplayOn: false,
    });
    const saved = { mode: "agents", closedLid: true, keepDisplayOn: true };
    await atomicWrite(path, saved);
    expect(await readPreferences(path)).toEqual(saved);
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual(saved);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
