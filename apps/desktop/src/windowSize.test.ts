import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { readWindowSize, writeWindowSize } from "./windowSize";

it("restores a tiled window size and rejects invalid bounds", () => {
  const dir = mkdtempSync(join(tmpdir(), "f5-window-"));
  const path = join(dir, "size.json");
  try {
    expect(readWindowSize(path)).toBeNull();
    writeWindowSize(path, { width: 400, height: 360 });
    expect(readWindowSize(path)).toEqual({ width: 400, height: 360 });
    for (const size of [
      { width: 399, height: 360 },
      { width: 400, height: 359 },
      { width: 400.5, height: 360 },
    ]) {
      writeFileSync(path, JSON.stringify(size));
      expect(readWindowSize(path)).toBeNull();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
