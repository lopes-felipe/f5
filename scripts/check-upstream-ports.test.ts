import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

const ROOT = path.resolve(import.meta.dirname, "..");
const SCRIPT = path.join(ROOT, "scripts", "check-upstream-ports.ts");
const sourceManifest = JSON.parse(
  readFileSync(path.join(ROOT, "scripts", "upstream-ports.manifest.json"), "utf8"),
) as Record<string, unknown>;
const sourceLedger = JSON.parse(
  readFileSync(path.join(ROOT, "scripts", "upstream-ports.json"), "utf8"),
) as {
  manifestSha256: string;
  entries: Array<Record<string, unknown>>;
};

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function runWith(ledger: unknown): ReturnType<typeof spawnSync> {
  const directory = mkdtempSync(path.join(tmpdir(), "f5-upstream-ports-test-"));
  temporaryDirectories.push(directory);
  const manifestPath = path.join(directory, "manifest.json");
  const ledgerPath = path.join(directory, "ledger.json");
  writeFileSync(manifestPath, JSON.stringify(sourceManifest));
  writeFileSync(ledgerPath, JSON.stringify(ledger));
  return spawnSync(process.execPath, [SCRIPT], {
    cwd: ROOT,
    encoding: "utf8",
    env: {
      ...process.env,
      CI: "1",
      F5_UPSTREAM_PORTS_MANIFEST_PATH: manifestPath,
      F5_UPSTREAM_PORTS_LEDGER_PATH: ledgerPath,
    },
  });
}

function runRaw(manifest: string, ledger: string): ReturnType<typeof spawnSync> {
  const directory = mkdtempSync(path.join(tmpdir(), "f5-upstream-ports-test-"));
  temporaryDirectories.push(directory);
  const manifestPath = path.join(directory, "manifest.json");
  const ledgerPath = path.join(directory, "ledger.json");
  writeFileSync(manifestPath, manifest);
  writeFileSync(ledgerPath, ledger);
  return spawnSync(process.execPath, [SCRIPT], {
    cwd: ROOT,
    encoding: "utf8",
    env: {
      ...process.env,
      CI: "1",
      F5_UPSTREAM_PORTS_MANIFEST_PATH: manifestPath,
      F5_UPSTREAM_PORTS_LEDGER_PATH: ledgerPath,
    },
  });
}

describe("check-upstream-ports", () => {
  it("rejects a malformed disposition row", () => {
    const ledger = structuredClone(sourceLedger);
    ledger.entries[0]!.disposition = "maybe";

    const result = runWith(ledger);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("invalid disposition maybe");
  }, 15_000);

  it("rejects a completed port with a non-resolving f5 SHA", () => {
    const ledger = structuredClone(sourceLedger);
    ledger.entries[0]!.disposition = "ported";
    ledger.entries[0]!.f5Shas = ["0000000000000000000000000000000000000000"];
    delete ledger.entries[0]!.reason;

    const result = runWith(ledger);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("references non-resolving f5 SHA");
  }, 15_000);

  it("reports malformed JSON without an uncaught type error", () => {
    const result = runRaw(JSON.stringify(sourceManifest), '{"schemaVersion":3,"entries":');

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("could not parse");
    expect(result.stderr).not.toContain("is not iterable");
  }, 15_000);

  it("rejects a manifest changed without updating its integrity digest", () => {
    const manifest = structuredClone(sourceManifest);
    manifest.selection = {
      ...(manifest.selection as Record<string, unknown>),
      boundarySha: "0000000000000000000000000000000000000000",
    };
    const result = runRaw(JSON.stringify(manifest), JSON.stringify(sourceLedger));

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("integrity digest");
  }, 15_000);
});
