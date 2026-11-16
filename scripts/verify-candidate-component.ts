// @effect-diagnostics nodeBuiltinImport:off
import { readdirSync, lstatSync } from "node:fs";
import { join } from "node:path";
import {
  api,
  hashFile,
  readArtifactJson,
  trustedRun,
  type WorkflowRun,
} from "./release/release-github.ts";
import { runArtifacts } from "./release/candidate-store.ts";
import {
  validateReceipt,
  type ComponentReceipt,
  type ReleasePlan,
} from "./release/release-candidate.ts";
const runId = Number(process.env.ARTIFACT_RUN),
  name = process.env.ARTIFACT_NAME!,
  directory = process.env.ARTIFACT_DIR!;
const run = api<WorkflowRun>("actions/runs/" + runId);
if (
  !trustedRun(run, "release.yml") ||
  (process.env.SOURCE_SHA && run.head_sha !== process.env.SOURCE_SHA)
)
  throw new Error("Untrusted component source");
const artifacts = runArtifacts(runId);
const planArtifact = artifacts
  .filter((a) => a.name.startsWith("release-plan-attempt-"))
  .toSorted((a, b) => Number(b.name.split("-").at(-1)) - Number(a.name.split("-").at(-1)))[0];
const receiptArtifact = artifacts.find((a) => a.name === "receipt-" + name);
if (!planArtifact || !receiptArtifact) throw new Error("Component provenance is missing/expired");
const plan = await readArtifactJson<ReleasePlan>(planArtifact, "release-plan.json");
const receipt = await readArtifactJson<ComponentReceipt>(receiptArtifact, "receipt.json");
validateReceipt(receipt, { ...plan, runAttempt: run.run_attempt });
if (
  plan.sourceSha !== run.head_sha ||
  plan.runId !== runId ||
  name !== receipt.component + "-attempt-" + receipt.runAttempt
)
  throw new Error("Component source/run/attempt mismatch");
const files = readdirSync(directory);
if (files.length !== receipt.files.length) throw new Error("Component inventory mismatch");
for (const expected of receipt.files) {
  const path = join(directory, expected.name);
  if (
    !files.includes(expected.name) ||
    !lstatSync(path).isFile() ||
    lstatSync(path).size !== expected.size ||
    (await hashFile(path)) !== expected.sha256
  )
    throw new Error("Component digest/size mismatch: " + expected.name);
}
