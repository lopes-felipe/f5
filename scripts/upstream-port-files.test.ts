import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  unlinkSync,
  existsSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readLedgerText, withLedgerLock, writeLedgerText } from "./upstream-port-files.ts";
import { ROOT, temp } from "./upstream-port-test-fixtures.ts";

const directories: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const d of directories.splice(0)) rmSync(d, { recursive: true, force: true });
});
function fixture() {
  const directory = temp();
  directories.push(directory);
  const file = path.join(directory, "ledger.json");
  writeFileSync(file, '{"generation":1}\n');
  return { directory, file, previous: readLedgerText(file), next: '{"generation":2}\n' };
}
describe("single-file publication", () => {
  it("serializes writers while readers see a complete file", () => {
    const { file, previous, next } = fixture();
    withLedgerLock(file, () => {
      expect(readLedgerText(file)).toBe(previous);
      expect(() => writeLedgerText(file, previous, next)).toThrow(`${file}.lock`);
    });
    writeLedgerText(file, previous, next);
    expect(readLedgerText(file)).toBe(next);
  });
  it("rejects a competing process while its owner holds the writer lock", () => {
    const { file, previous, next } = fixture();
    const url = pathToFileURL(path.join(ROOT, "scripts/upstream-port-files.ts")).href;
    withLedgerLock(file, () => {
      const result = spawnSync(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `import { writeLedgerText } from ${JSON.stringify(url)}; writeLedgerText(${JSON.stringify(file)}, ${JSON.stringify(previous)}, ${JSON.stringify(next)});`,
        ],
        { encoding: "utf8" },
      );
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain(`${file}.lock`);
      expect(readLedgerText(file)).toBe(previous);
    });
    writeLedgerText(file, previous, next);
    expect(readLedgerText(file)).toBe(next);
  });
  it("leaves another writer's replacement lock intact", () => {
    const { file } = fixture();
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    withLedgerLock(file, () => {
      unlinkSync(`${file}.lock`);
      writeFileSync(`${file}.lock`, JSON.stringify({ token: "replacement-writer" }));
    });
    expect(JSON.parse(readFileSync(`${file}.lock`, "utf8")).token).toBe("replacement-writer");
    expect(warning).toHaveBeenCalledWith(expect.stringContaining("ownership changed"));
  });
  it.each([false, true])("cleanup failure preserves the main outcome (throws=%s)", (throws) => {
    const { file } = fixture();
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    const failure = new Error("original operation failure");
    const operation = () =>
      withLedgerLock(file, () => {
        unlinkSync(`${file}.lock`);
        mkdirSync(`${file}.lock`); // Force an actual filesystem cleanup failure.
        if (throws) throw failure;
        return "published";
      });
    if (throws) expect(operation).toThrow(failure);
    else expect(operation()).toBe("published");
    expect(warning).toHaveBeenCalledWith(expect.stringContaining("cleanup failed"));
  });
  it.each(["", "{", '{"pid":999999,"host":"other"}'])(
    "never steals malformed or stale lock %j",
    (lock) => {
      const { file, previous, next } = fixture();
      writeFileSync(`${file}.lock`, lock);
      expect(() => writeLedgerText(file, previous, next)).toThrow("never stolen");
      expect(readLedgerText(file)).toBe(previous);
      expect(readFileSync(`${file}.lock`, "utf8")).toBe(lock);
    },
  );
  it("refuses stale snapshots and edits made while staging", () => {
    const { directory, file, previous, next } = fixture();
    writeFileSync(file, "external edit");
    expect(() => writeLedgerText(file, previous, next)).toThrow("changed");
    expect(readLedgerText(file)).toBe("external edit");
    writeFileSync(file, previous);
    expect(() =>
      writeLedgerText(file, previous, next, {
        beforeRename: () => writeFileSync(file, "new edit"),
      }),
    ).toThrow("changed");
    expect(readLedgerText(file)).toBe("new edit");
    expect(readdirSync(directory)).toEqual(["ledger.json"]);
  });
  it("preserves permissions and removes its own temporary files on failure", () => {
    const { file, directory, previous, next } = fixture();
    chmodSync(file, 0o640);
    expect(() =>
      writeLedgerText(file, previous, next, {
        beforeRename: () => {
          throw new Error("write interrupted");
        },
      }),
    ).toThrow("interrupted");
    expect(readLedgerText(file)).toBe(previous);
    expect(readdirSync(directory)).toEqual(["ledger.json"]);
    writeLedgerText(file, previous, next);
    if (process.platform !== "win32") expect(statSync(file).mode & 0o777).toBe(0o640);
  });
  it.each(["beforeRename", "afterRename"] as const)(
    "survives process death at %s without reader recovery",
    (hook) => {
      const { file, previous, next } = fixture();
      const url = pathToFileURL(path.join(ROOT, "scripts/upstream-port-files.ts")).href;
      const result = spawnSync(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `import { writeLedgerText } from ${JSON.stringify(url)}; writeLedgerText(${JSON.stringify(file)}, ${JSON.stringify(previous)}, ${JSON.stringify(next)}, { ${hook}: () => process.kill(process.pid, "SIGKILL") });`,
        ],
        { encoding: "utf8" },
      );
      expect(result.status).not.toBe(0);
      expect(JSON.parse(readLedgerText(file))).toEqual(
        JSON.parse(hook === "beforeRename" ? previous : next),
      );
      expect(existsSync(`${file}.lock`)).toBe(true);
      expect(() => writeLedgerText(file, readLedgerText(file), next)).toThrow(`${file}.lock`);
    },
  );
});
