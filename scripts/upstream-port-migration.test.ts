import { mkdirSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { migrateLegacyLedger } from "./upstream-port-migration.ts";
import { type LegacyLedger } from "./upstream-port-legacy-ledger.ts";
import { recoverPortFiles } from "./upstream-port-legacy-files.ts";
import { sha256 } from "./upstream-port-ledger.ts";
import { parseLedger } from "./upstream-port-validation.ts";
import { AUTHORITATIVE_REPOSITORY } from "./upstream-port-history.ts";
import { ROOT, repository, runCheck, temp } from "./upstream-port-test-fixtures.ts";

const directories: string[] = [];
afterEach(() => {
  for (const d of directories.splice(0)) rmSync(d, { recursive: true, force: true });
});
function pair() {
  const r = repository(501);
  directories.push(r.directory);
  const selected = r.commits.slice(0, 500);
  const manifest = {
    schemaVersion: 1,
    upstream: {
      authoritativeRepository: AUTHORITATIVE_REPOSITORY,
      localMirror: "fixture",
      localMirrorAuthoritative: false,
    },
    selection: {
      rule: "first-parent",
      maxCount: 500,
      headSha: selected[0]!.sha,
      firstSha: selected[0]!.sha,
      lastSha: selected.at(-1)!.sha,
      boundarySha: selected.at(-1)!.sha,
      count: 500,
    },
    commits: selected,
  };
  const text = JSON.stringify(manifest);
  const bySha = new Map(r.ledger.entries.map((e) => [e.upstreamSha, e]));
  const legacy: LegacyLedger = {
    schemaVersion: 5,
    manifest: "scripts/upstream-ports.manifest.json",
    manifestSha256: sha256(text),
    entries: selected.map((c) => bySha.get(c.sha)!),
    historicalEntries: [],
    olderBacklog: [],
    audit: r.ledger.intervals[0]!,
  };
  const manifestFile = path.join(r.directory, "manifest.json");
  writeFileSync(manifestFile, text);
  writeFileSync(r.file, JSON.stringify(legacy));
  return {
    ...r,
    legacy,
    manifestFile,
    manifestText: text,
    run: () =>
      runCheck(r.directory, r.file, ["--migrate"], {
        F5_UPSTREAM_PORTS_MANIFEST_PATH: manifestFile,
      }),
  };
}
describe("schema-5 migration", () => {
  it("reconstructs and preserves all 2,332 real records including 10 category members", () => {
    const current = parseLedger(
      readFileSync(path.join(ROOT, "scripts/upstream-ports.json"), "utf8"),
    );
    const materialized = new Set(current.legacyProvenance.flatMap((c) => c.upstreamShas ?? []));
    expect(materialized.size).toBe(10);
    const interval = current.intervals[0]!;
    const window = new Set(interval.upstreamShas.slice(0, 500));
    const originalCoverage = new Set([
      ...interval.upstreamShas,
      ...current.legacyCoverage.upstreamShas,
    ]);
    const originalEntries = current.entries.filter((e) => originalCoverage.has(e.upstreamSha));
    const records = originalEntries.filter((e) => !materialized.has(e.upstreamSha));
    const legacy: LegacyLedger = {
      schemaVersion: 5,
      manifest: "scripts/upstream-ports.manifest.json",
      manifestSha256: "unused in pure migration",
      entries: records.filter((e) => window.has(e.upstreamSha)),
      historicalEntries: records.filter((e) => !window.has(e.upstreamSha)),
      audit: interval,
      olderBacklog: current.legacyProvenance,
    };
    const migrated = migrateLegacyLedger(
      legacy,
      new Map(current.entries.map((e) => [e.upstreamSha, e.subject])),
    );
    expect(migrated).toEqual({ ...current, entries: originalEntries, intervals: [interval] });
    expect(migrated.entries).toHaveLength(2332);
    expect(migrated.legacyCoverage.count).toBe(496);
    for (const record of records)
      expect(migrated.entries.find((e) => e.upstreamSha === record.upstreamSha)).toEqual(record);
  });
  it("publishes schema 6 before removing the manifest and is idempotent", () => {
    const p = pair();
    const result = p.run();
    expect(result.status, result.stderr).toBe(0);
    const text = readFileSync(p.file, "utf8");
    const migrated = parseLedger(text);
    expect(migrated.entries).toEqual(p.ledger.entries);
    expect(existsSync(p.manifestFile)).toBe(false);
    // Simulate a crash after publication but before obsolete-file cleanup.
    writeFileSync(p.manifestFile, "obsolete malformed manifest");
    expect(p.run().status).toBe(0);
    expect(readFileSync(p.file, "utf8")).toBe(text);
    expect(runCheck(p.directory, p.file).status).toBe(0);
  });
  it.each(["digest", "duplicate", "subject", "boundary"])(
    "rejects invalid %s without changing either file",
    (problem) => {
      const p = pair();
      let changed = p.legacy;
      if (problem === "digest") changed = { ...changed, manifestSha256: "0".repeat(64) };
      if (problem === "duplicate")
        changed = { ...changed, historicalEntries: [changed.entries[0]!] };
      if (problem === "subject")
        changed = {
          ...changed,
          entries: [{ ...changed.entries[0]!, subject: "forged" }, ...changed.entries.slice(1)],
        };
      if (problem === "boundary")
        changed = { ...changed, audit: { ...changed.audit!, baseSha: changed.audit!.targetSha } };
      const text = JSON.stringify(changed);
      writeFileSync(p.file, text);
      expect(p.run().status).toBe(1);
      expect(readFileSync(p.file, "utf8")).toBe(text);
      expect(readFileSync(p.manifestFile, "utf8")).toBe(p.manifestText);
    },
  );
  it.each(["", "{"])("refuses an empty/truncated old journal %j", (journal) => {
    const p = pair();
    writeFileSync(`${p.file}.refresh-journal`, journal);
    const result = p.run();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("empty or truncated");
    expect(readFileSync(`${p.file}.refresh-journal`, "utf8")).toBe(journal);
    expect(JSON.parse(readFileSync(p.file, "utf8")).schemaVersion).toBe(5);
  });
  it("refuses a live legacy writer", () => {
    const p = pair();
    const files = { ledger: p.file, manifest: p.manifestFile };
    const journal = {
      pid: process.pid,
      host: hostname(),
      paths: files,
      ledger: readFileSync(p.file, "utf8"),
      manifest: p.manifestText,
    };
    writeFileSync(`${p.file}.refresh-journal`, JSON.stringify(journal));
    const result = p.run();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("already running");
    expect(JSON.parse(readFileSync(p.file, "utf8")).schemaVersion).toBe(5);
  });
  it("names an interrupted recovery lock and refuses unverifiable identity metadata", () => {
    const p = pair();
    const journalPath = `${p.file}.refresh-journal`;
    const journal = {
      pid: process.pid,
      host: hostname(),
      processStart: "previous-boot",
      paths: { ledger: p.file, manifest: p.manifestFile },
      ledger: readFileSync(p.file, "utf8"),
      manifest: p.manifestText,
    };
    writeFileSync(journalPath, JSON.stringify({ ...journal, processStart: 123 }));
    expect(p.run().status).toBe(1);
    writeFileSync(journalPath, JSON.stringify(journal));
    mkdirSync(`${journalPath}.recovering`);
    const result = p.run();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`${journalPath}.recovering`);
    expect(readFileSync(p.file, "utf8")).toBe(journal.ledger);
  });
  it("recovers a dead schema-5 writer's split publication before migration", () => {
    const p = pair();
    const files = { ledger: p.file, manifest: p.manifestFile };
    // PID reuse is ruled out by an intentionally different creation identity.
    writeFileSync(
      `${p.file}.refresh-journal`,
      JSON.stringify({
        pid: process.pid,
        host: hostname(),
        processStart: "previous-boot",
        paths: files,
        ledger: readFileSync(p.file, "utf8"),
        manifest: p.manifestText,
      }),
    );
    writeFileSync(p.manifestFile, "interrupted replacement");
    expect(p.run().status).toBe(0);
    expect(parseLedger(readFileSync(p.file, "utf8")).entries).toEqual(p.ledger.entries);
  });
  it("retains an already-completed legacy publication during recovery", () => {
    const directory = temp();
    directories.push(directory);
    const files = {
      ledger: path.join(directory, "ledger.json"),
      manifest: path.join(directory, "manifest.json"),
    };
    const next = { ledger: "new ledger", manifest: "new manifest" };
    writeFileSync(files.ledger, next.ledger);
    writeFileSync(files.manifest, next.manifest);
    writeFileSync(
      `${files.ledger}.refresh-journal`,
      JSON.stringify({
        pid: process.pid,
        host: hostname(),
        processStart: "previous-boot",
        paths: files,
        ledger: "old ledger",
        manifest: "old manifest",
        nextDigest: { ledger: sha256(next.ledger), manifest: sha256(next.manifest) },
      }),
    );
    recoverPortFiles(files);
    expect(readFileSync(files.ledger, "utf8")).toBe(next.ledger);
    expect(readFileSync(files.manifest, "utf8")).toBe(next.manifest);
  });
});
