// @effect-diagnostics nodeBuiltinImport:off
import { appendFileSync, writeFileSync } from "node:fs";
import { loadCandidate } from "./release/candidate-store.ts";
import { sameBaselines, upgradePlan } from "./release/release-upgrade-proof.ts";
import { fetchReleaseSummaries } from "./lib/release-profile.ts";
import { repository } from "./release/release-github.ts";
const candidate = await loadCandidate(Number(process.env.CANDIDATE_RUN));
const plan = upgradePlan(candidate, fetchReleaseSummaries(repository));
if (plan.key !== process.env.UPGRADE_KEY)
  throw new Error("Upgrade dispatch is stale or mismatched");
const artifact = candidate.artifacts.find((a) => a.component === "desktop-win-x64")!;
appendFileSync(
  process.env.GITHUB_OUTPUT!,
  [
    "matrix=" + JSON.stringify({ include: plan.baselines }),
    "version=" + candidate.version,
    "channel=" + candidate.channel,
    "source_sha=" + candidate.sourceSha,
    "artifact=" + artifact.name,
    "windows_required=" + !sameBaselines(candidate.windowsBaselines, plan.baselines),
    "cli_required=" + Boolean(plan.cliTargets.length),
    "cli_baseline=" + plan.cliBaseline,
    "cli_matrix=" +
      JSON.stringify({
        include: plan.cliTargets.length
          ? plan.cliTargets
          : [{ os: "ubuntu-latest", target: "linux-x64", artifact: "unused" }],
      }),
  ].join("\n") + "\n",
);
writeFileSync("proof.json", JSON.stringify({ key: plan.key, candidate }, null, 2) + "\n");
