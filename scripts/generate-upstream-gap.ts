import { readFileSync } from "node:fs";
import path from "node:path";
import { applyPortPlan, type PortPlan } from "./upstream-port-plan.ts";
import { coveredInterval } from "./upstream-port-ledger.ts";
import { parseLedger } from "./upstream-port-validation.ts";
import { readLedgerText, publishLedgerText, withLedgerLock } from "./upstream-port-files.ts";
import { root, ledgerPath, checkLedger } from "./upstream-port-runtime.ts";

try {
  if (process.argv.length > 3)
    throw new Error("usage: bun scripts/generate-upstream-gap.ts [classification-file]");
  const plan = JSON.parse(
    readFileSync(
      path.resolve(process.argv[2] ?? path.join(root, "scripts/upstream-port-plan-2026-09.json")),
      "utf8",
    ),
  ) as PortPlan;
  withLedgerLock(ledgerPath, () => {
    const expected = readLedgerText(ledgerPath);
    const previous = parseLedger(expected);
    checkLedger(previous, { allowPending: true, requireUpstream: true });
    const entries = new Map(previous.entries.map((entry) => [entry.upstreamSha, entry]));
    const commits = coveredInterval(previous, plan.baseSha, plan.targetSha).map((sha) => ({
      sha,
      subject: entries.get(sha)!.subject,
    }));
    const next = applyPortPlan(previous, commits, plan);
    checkLedger(next, { allowPending: true, requireUpstream: true });
    publishLedgerText(ledgerPath, expected, `${JSON.stringify(next, null, 2)}\n`);
    console.log(
      `Applied ${commits.length} exact-SHA classifications within tracked coverage; planned items remain deferred.`,
    );
  });
} catch (error) {
  console.error(`upstream port classification: ${String(error)}`);
  process.exitCode = 1;
}
