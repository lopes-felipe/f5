// @effect-diagnostics nodeBuiltinImport:off
import { writeFileSync } from "node:fs";
import { readArtifactJson } from "./release/release-github.ts";
import { runArtifacts } from "./release/candidate-store.ts";
const attempt = Number(process.env.GITHUB_RUN_ATTEMPT);
const artifact = runArtifacts(Number(process.env.GITHUB_RUN_ID))
  .filter((a) => a.name.startsWith("upgrade-plan-") && Number(a.name.split("-").at(-1)) <= attempt)
  .toSorted((a, b) => Number(b.name.split("-").at(-1)) - Number(a.name.split("-").at(-1)))[0];
if (!artifact) throw new Error("Missing requalification plan");
const proof = await readArtifactJson<{ key: string }>(artifact, "proof.json");
if (proof.key !== process.env.UPGRADE_KEY) throw new Error("Qualification proof identity mismatch");
writeFileSync("proof.json", JSON.stringify(proof, null, 2) + "\n");
