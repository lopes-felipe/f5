import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

it.each(["node", "bun"])(
  "%s waits for a separate SQLite writer",
  async (runtime) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "f5-sqlite-busy-"));
    const filename = path.join(directory, "state.sqlite");
    const child = spawn(
      runtime === "node" ? process.execPath : "bun",
      [
        ...(runtime === "node" ? ["--experimental-strip-types"] : []),
        fileURLToPath(new URL("./fixtures/sqliteBusyWriter.ts", import.meta.url)),
        filename,
      ],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    let output = "";
    let errors = "";
    child.stdout.on("data", (data) => {
      output += data.toString();
    });
    child.stderr.on("data", (data) => {
      errors += data.toString();
    });
    const exited = once(child, "exit");
    let database: DatabaseSync | undefined;
    let release: ReturnType<typeof setTimeout> | undefined;
    try {
      await expect
        .poll(() => output.includes("ready") || child.exitCode !== null, { timeout: 30_000 })
        .toBe(true);
      expect(output, errors).toContain("ready");
      database = new DatabaseSync(filename);
      database.exec("BEGIN IMMEDIATE; INSERT INTO contention_test VALUES ('parent')");
      child.stdin.write("write\n");
      await expect
        .poll(() => output.includes("writing") || child.exitCode !== null, { timeout: 30_000 })
        .toBe(true);
      expect(output, errors).toContain("writing");
      release = setTimeout(() => database!.exec("COMMIT"), 250);
      const [code] = await exited;
      expect(code, errors).toBe(0);
      expect(output).toContain("written:");
      const elapsed = Number(/written:([0-9.]+)/.exec(output)?.[1]);
      expect(elapsed).toBeGreaterThanOrEqual(200);
      expect(database.prepare("SELECT value FROM contention_test ORDER BY rowid").all()).toEqual([
        { value: "parent" },
        { value: "child" },
      ]);
    } finally {
      if (release) clearTimeout(release);
      if (child.exitCode === null) {
        child.kill();
        await exited;
      }
      database?.close();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  },
  45_000,
);
