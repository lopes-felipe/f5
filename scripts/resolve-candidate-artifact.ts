// @effect-diagnostics nodeBuiltinImport:off
import { appendFileSync } from "node:fs";
import { api, trustedRun, type WorkflowRun } from "./release/release-github.ts";
import { runArtifacts } from "./release/candidate-store.ts";
const runId = Number(process.env.ARTIFACT_RUN ?? process.env.GITHUB_RUN_ID);
const run = api<WorkflowRun>("actions/runs/" + runId);
if (
  !trustedRun(run, "release.yml") ||
  (process.env.SOURCE_SHA && run.head_sha !== process.env.SOURCE_SHA)
)
  throw new Error("Artifact must belong to the exact trusted candidate source");
const requested = process.env.REQUESTED_ARTIFACT!;
if (!/^(desktop-win-x64|windows-bundles)-attempt-[1-9]\d*$/.test(requested))
  throw new Error("Unexpected artifact request");
const prefix = requested.replace(/-attempt-\d+$/, "-attempt-");
const maxAttempt = Number(requested.split("-").at(-1));
const artifact = runArtifacts(runId)
  .filter(
    (a) =>
      a.name.startsWith(prefix) && !a.expired && Number(a.name.slice(prefix.length)) <= maxAttempt,
  )
  .toSorted((a, b) => Number(b.name.slice(prefix.length)) - Number(a.name.slice(prefix.length)))[0];
if (!artifact)
  throw new Error("Required candidate artifact is missing/expired; do not rebuild implicitly");
appendFileSync(process.env.GITHUB_OUTPUT!, "name=" + artifact.name + "\n");
