import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { it, expect } from "vitest";
import { readCookies } from "./readCookies";
it("imports synthetic Firefox cookies from a copied locked source and skips partitions", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "f5-cookie-db-test-")),
    database = path.join(root, "cookies.sqlite");
  const db = new DatabaseSync(database);
  db.exec(
    "PRAGMA journal_mode=WAL; CREATE TABLE moz_cookies(host TEXT,name TEXT,value TEXT,path TEXT,expiry INTEGER,isSecure INTEGER,isHttpOnly INTEGER,sameSite INTEGER,originAttributes TEXT); INSERT INTO moz_cookies VALUES('example.test','__Host-test','synthetic','/',0,1,1,1,''),('example.test','partitioned','other','/',0,1,1,1,'^partitionKey=other');",
  );
  const before = await readFile(database);
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = await readCookies(
      { id: "fixture", name: "Fixture", database, root, engine: "firefox" },
      new AbortController().signal,
    );
    expect(result.cookies.length).toBe(1);
    expect(result.skipped).toBe(1);
    expect(result.cookies[0]).not.toHaveProperty("domain");
    expect(await readFile(database)).toEqual(before);
  } finally {
    db.exec("ROLLBACK");
    db.close();
  }
});
it("sanitizes corrupt database and denied source failures", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "f5-corrupt-cookie-test-")),
    database = path.join(root, "cookies.sqlite");
  await writeFile(database, "COOKIE_SECRET_MUST_NOT_LEAK");
  await expect(
    readCookies(
      { id: "fixture", name: "Fixture", database, root, engine: "firefox" },
      new AbortController().signal,
    ),
  ).rejects.toThrow("Cookie source could not be read");
  await expect(
    readCookies(
      { id: "fixture", name: "Fixture", database: database + "missing", root, engine: "firefox" },
      new AbortController().signal,
    ),
  ).rejects.not.toThrow("COOKIE_SECRET");
});

it.each([15, 16])(
  "converts Firefox schema %i expiry and preserves explicit SameSite",
  async (version) => {
    const root = await mkdtemp(path.join(tmpdir(), "f5-firefox-version-test-"));
    const database = path.join(root, "cookies.sqlite");
    const db = new DatabaseSync(database);
    db.exec(
      `PRAGMA user_version=${version}; CREATE TABLE moz_cookies(host TEXT,name TEXT,value TEXT,path TEXT,expiry INTEGER,isSecure INTEGER,isHttpOnly INTEGER,sameSite INTEGER,originAttributes TEXT)`,
    );
    const expirySeconds = 2000000000;
    const insert = db.prepare(
      "INSERT INTO moz_cookies VALUES('example.test',?,'synthetic','/',?,1,1,?,'')",
    );
    insert.run("explicit-none", expirySeconds * (version >= 16 ? 1000 : 1), 0);
    insert.run("unset", 0, 256);
    db.close();
    const result = await readCookies(
      { id: "fixture", name: "Fixture", database, root, engine: "firefox" },
      new AbortController().signal,
    );
    expect(result.cookies[0]).toMatchObject({
      expirationDate: expirySeconds,
      sameSite: "no_restriction",
    });
    expect(result.cookies[1]).toMatchObject({ sameSite: "unspecified" });
    expect(result.cookies[1]).not.toHaveProperty("expirationDate");
  },
);
