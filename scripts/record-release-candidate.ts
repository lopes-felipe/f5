// @effect-diagnostics nodeBuiltinImport:off
import { writeFileSync } from "node:fs";
import { api, readArtifactJson, trustedRun, type WorkflowRun } from "./release/release-github.ts";
import {
  releaseComponents,
  validateCandidate,
  validateReceipt,
  type ComponentReceipt,
  type ReleaseCandidate,
  type ReleasePlan,
} from "./release/release-candidate.ts";
import { runArtifacts } from "./release/candidate-store.ts";

const id = Number(process.env.GITHUB_RUN_ID),
  attempt = Number(process.env.GITHUB_RUN_ATTEMPT);
const run = api<WorkflowRun>("actions/runs/" + id);
if (!trustedRun(run, "release.yml")) throw new Error("Untrusted candidate build run");
const artifacts = runArtifacts(id);
const planArtifact = artifacts
  .filter(
    (a) =>
      a.name.startsWith("release-plan-attempt-") && Number(a.name.split("-").at(-1)) <= attempt,
  )
  .toSorted((a, b) => Number(b.name.split("-").at(-1)) - Number(a.name.split("-").at(-1)))[0];
if (!planArtifact) throw new Error("Missing release plan");
const originalPlan = await readArtifactJson<ReleasePlan>(planArtifact, "release-plan.json");
if (
  originalPlan.sourceSha !== run.head_sha ||
  originalPlan.runId !== id ||
  originalPlan.runAttempt > attempt
)
  throw new Error("Release plan does not match workflow");
const plan = { ...originalPlan, runAttempt: attempt };
const components: ReleaseCandidate["artifacts"][number][] = [];
for (const component of releaseComponents(plan.profile)) {
  const receiptArtifacts = artifacts
    .filter((a) => a.name.startsWith("receipt-" + component + "-attempt-"))
    .toSorted((a, b) => Number(b.name.split("-").at(-1)) - Number(a.name.split("-").at(-1)));
  const receiptArtifact = receiptArtifacts[0];
  if (!receiptArtifact) throw new Error("Missing receipt for " + component);
  const receipt = await readArtifactJson<ComponentReceipt>(receiptArtifact, "receipt.json");
  validateReceipt(receipt, plan);
  const name = component + "-attempt-" + receipt.runAttempt;
  const artifact = artifacts.find((a) => a.name === name);
  if (!artifact || artifact.expired) throw new Error("Missing/expired component " + component);
  components.push({ id: artifact.id, name, digest: artifact.digest, component, receipt });
}
// Receipts are taken from the actual test jobs, not recomputed from a possibly newer feed.
const testReceipts = artifacts.filter((a) => a.name.startsWith("upgrade-receipt-"));
const baselines = plan.windowsBaselines;
for (const baseline of baselines) {
  let found = false;
  for (const artifact of testReceipts) {
    const receipt = await readArtifactJson<{
      baseline: string;
      baselineChannel: string;
      clientChannel: string;
      target: string;
      sourceSha: string;
      installerSha256: string;
    }>(artifact, "upgrade.json");
    const windows = components.find((c) => c.component === "desktop-win-x64")!;
    const exe = windows.receipt.files.find((f) => f.name.endsWith(".exe"));
    if (
      receipt.baseline === baseline.baseline &&
      receipt.baselineChannel === baseline.baselineChannel &&
      receipt.clientChannel === baseline.clientChannel &&
      receipt.target === plan.version &&
      receipt.sourceSha === plan.sourceSha &&
      receipt.installerSha256 === exe?.sha256
    )
      found = true;
  }
  if (!found)
    throw new Error("Published upgrade receipt missing or stale: " + JSON.stringify(baseline));
}
const candidate: ReleaseCandidate = { ...plan, artifacts: components, windowsBaselines: baselines };
validateCandidate(candidate);
writeFileSync("candidate.json", JSON.stringify(candidate, null, 2) + "\n");
