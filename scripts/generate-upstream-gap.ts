import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { verifyUpstream } from "./upstream-port-history.ts";
import { readPortFiles, writePortFiles } from "./upstream-port-files.ts";
import { applyPortPlan, type PortPlan } from "./upstream-port-plan.ts";
import { SHA_PATTERN, sha256, validateAudit, type Ledger } from "./upstream-port-ledger.ts";

const root = path.resolve(import.meta.dirname, "..");
const files = {
  manifest: path.join(root, "scripts/upstream-ports.manifest.json"),
  ledger: path.join(root, "scripts/upstream-ports.json"),
};
try {
  if (process.argv.length > 3)
    throw new Error("usage: bun scripts/generate-upstream-gap.ts [classification-file]");
  const plan = JSON.parse(
    readFileSync(
      path.resolve(process.argv[2] ?? path.join(root, "scripts/upstream-port-plan-2026-09.json")),
      "utf8",
    ),
  ) as PortPlan;
  if (!SHA_PATTERN.test(plan.baseSha) || !SHA_PATTERN.test(plan.targetSha))
    throw new Error("classification boundaries must be full SHAs");
  const git = (args: ReadonlyArray<string>) =>
    execFileSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 }).trim();
  verifyUpstream(git);
  const ancestry = git(["rev-list", "--first-parent", "upstream/main"]).split("\n");
  const headIndex = ancestry.indexOf(plan.targetSha);
  const baseIndex = ancestry.indexOf(plan.baseSha);
  if (headIndex < 0 || baseIndex <= headIndex)
    throw new Error(
      "classification boundaries must select a nonempty upstream first-parent interval",
    );
  const selected = ancestry.slice(headIndex, baseIndex);
  const commits = git([
    "log",
    "--first-parent",
    "--format=%H%x09%s",
    `${plan.baseSha}..${plan.targetSha}`,
  ])
    .split("\n")
    .map((line) => ({ sha: line.slice(0, 40), subject: line.slice(41) }));
  if (JSON.stringify(commits.map((commit) => commit.sha)) !== JSON.stringify(selected))
    throw new Error("classification interval differs from upstream first-parent selection");
  const previous = readPortFiles(files);
  const ledger = JSON.parse(previous.ledger) as Ledger;
  if (ledger.manifestSha256 !== sha256(previous.manifest))
    throw new Error("manifest/ledger integrity mismatch");
  const next = applyPortPlan(ledger, commits, plan);
  const errors = validateAudit(next);
  if (errors.length) throw new Error(errors.join("\n"));
  const preflight = mkdtempSync(path.join(tmpdir(), "f5-upstream-audit-"));
  try {
    const manifestPath = path.join(preflight, "manifest.json");
    const ledgerPath = path.join(preflight, "ledger.json");
    writeFileSync(manifestPath, previous.manifest);
    writeFileSync(ledgerPath, `${JSON.stringify(next, null, 2)}\n`);
    execFileSync(process.execPath, [path.join(root, "scripts/check-upstream-ports.ts")], {
      cwd: root,
      stdio: "pipe",
      env: {
        ...process.env,
        F5_REQUIRE_UPSTREAM: "1",
        F5_UPSTREAM_PORTS_ROOT: root,
        F5_UPSTREAM_PORTS_MANIFEST_PATH: manifestPath,
        F5_UPSTREAM_PORTS_LEDGER_PATH: ledgerPath,
      },
    });
  } finally {
    rmSync(preflight, { recursive: true, force: true });
  }
  writePortFiles(files, previous, {
    manifest: previous.manifest,
    ledger: `${JSON.stringify(next, null, 2)}\n`,
  });
  console.log(
    `Applied ${commits.length} exact-SHA classifications; planned items remain deferred.`,
  );
} catch (error) {
  console.error(`upstream port classification: ${String(error)}`);
  process.exitCode = 1;
}
