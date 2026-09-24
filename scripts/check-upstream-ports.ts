import { existsSync, unlinkSync } from "node:fs";
import { classifyCommit } from "./upstream-port-suggestions.ts";
import { selectRefreshHead, newCommitsSince } from "./upstream-port-history.ts";
import { appendInterval } from "./upstream-port-ledger.ts";
import { parseLedger, assertValid } from "./upstream-port-validation.ts";
import { readLedgerText, publishLedgerText, withLedgerLock } from "./upstream-port-files.ts";
import { root, ledgerPath, legacyManifestPath, git, checkLedger } from "./upstream-port-runtime.ts";

function refresh(pin?: string): void {
  withLedgerLock(ledgerPath, () => {
    const expected = readLedgerText(ledgerPath);
    const previous = parseLedger(expected);
    assertValid(previous, root, true);
    const head = selectRefreshHead(git, pin);
    checkLedger(previous, { allowPending: true, requireUpstream: true });
    const latest = previous.intervals.at(-1)!.targetSha;
    const commits = newCommitsSince(git, latest, head);
    if (!commits.length) {
      console.log(
        `Already tracked through ${latest}; pin ${head} adds nothing and does not shrink coverage.`,
      );
      return;
    }
    const next = appendInterval(previous, commits, classifyCommit);
    checkLedger(next, { allowPending: true, requireUpstream: true });
    publishLedgerText(ledgerPath, expected, `${JSON.stringify(next, null, 2)}\n`);
    console.log(
      `Tracked ${commits.length} new commits through ${head}; new records require review, not implementation credit.`,
    );
  });
}
async function migrate(): Promise<void> {
  // Schema 6 never needs the old journal/manifest, even after interrupted cleanup.
  const current: unknown = JSON.parse(readLedgerText(ledgerPath));
  if (
    typeof current === "object" &&
    current !== null &&
    "schemaVersion" in current &&
    current.schemaVersion === 6
  ) {
    checkLedger(parseLedger(readLedgerText(ledgerPath)), { requireUpstream: true });
    console.log("Ledger is already schema 6; obsolete manifest files, if any, are ignored.");
    return;
  }
  const { recoverPortFiles, readPortFiles } = await import("./upstream-port-legacy-files.ts");
  const { prepareMigration } = await import("./upstream-port-migration.ts");
  withLedgerLock(ledgerPath, () => {
    const files = { ledger: ledgerPath, manifest: legacyManifestPath };
    recoverPortFiles(files);
    const { expected, expectedManifest, ledger } = prepareMigration(files, root, git);
    const current = readPortFiles(files);
    if (current.ledger !== expected || current.manifest !== expectedManifest)
      throw new Error("legacy pair changed during migration");
    publishLedgerText(ledgerPath, expected, `${JSON.stringify(ledger, null, 2)}\n`);
    // Publishing first makes an interrupted removal harmless to schema-6 readers.
    if (existsSync(legacyManifestPath)) unlinkSync(legacyManifestPath);
    console.log(
      `Migrated ${ledger.entries.length} records to schema 6 without changing decisions.`,
    );
  });
}
function validate(): void {
  const ledger = parseLedger(readLedgerText(ledgerPath));
  const pending = ledger.entries.filter((e) => e.reviewStatus === "pending").length;
  const planned = ledger.entries.filter(
    (e) => e.disposition === "deferred" && e.plannedWorkstream,
  ).length;
  const counts = ["ported", "equivalent", "already-present"]
    .map(
      (disposition) =>
        `${disposition}: ${ledger.entries.filter((e) => e.disposition === disposition).length}`,
    )
    .join(", ");
  console.log(
    `Upstream ledger: ${ledger.entries.length} records; ${ledger.intervals.reduce((n, i) => n + i.count, 0)} interval commits; ${ledger.legacyCoverage.count} legacy commits; pending reviews: ${pending}; planned: ${planned}; ${counts}.`,
  );
  checkLedger(ledger);
  console.log("Upstream port ledger valid.");
}
try {
  const args = process.argv.slice(2);
  let operation: "refresh" | "migrate" | undefined;
  let pin: string | undefined;
  for (let i = 0; i < args.length; i++) {
    if ((args[i] === "--refresh" || args[i] === "--migrate") && operation === undefined)
      operation = args[i] === "--refresh" ? "refresh" : "migrate";
    else if (args[i] === "--head" && pin === undefined && args[i + 1]) pin = args[++i];
    else throw new Error(`unknown or duplicate argument: ${args[i]}`);
  }
  if (pin !== undefined && operation !== "refresh") throw new Error("--head requires --refresh");
  if (operation === "refresh") refresh(pin);
  else if (operation === "migrate") await migrate();
  else validate();
} catch (error) {
  console.error(`upstream ports: ${String(error)}`);
  process.exitCode = 1;
}
