/**
 * Phase 2 of certification: operator acceptance of one release draft's exact artifact.
 *
 *   bun run integrations:accept --integration codex-chrome --tag v1.2.3 \
 *     --artifact ~/Downloads/F5-1.2.3-arm64.dmg [--app /Applications/F5.app] [--output <file>]
 *
 * Install the draft's DMG first. The runner hashes the DMG, mounts it read-only and
 * requires the installed app to have the same code-signing cdhash and version, reads the
 * certifying records from the tag, then walks the checklist: observed checks are measured
 * here, the rest are confirmed by the operator. It writes the report even on failure;
 * `promote-release.ts` accepts only an all-passed report for the same artifact digest.
 * Run it from Terminal, outside F5.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import {
  PROVIDER_INTEGRATION_RECORDS,
  recordCertifies,
  type IntegrationAcceptanceReport,
  type ProviderIntegration,
  type ProviderIntegrationRecord,
} from "@t3tools/shared/providerIntegrationCertification";
import {
  acceptanceReportPath,
  cdhashFromCodesign,
  macArtifactName,
  runAcceptanceChecklist,
  type AcceptanceProcess,
} from "./lib/integration-acceptance.ts";
import { startMutationServer } from "./lib/mutation-fixture.ts";

const root = resolve(import.meta.dirname, "..");
const argument = (name: string) => {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
};
const integration = argument("--integration") as ProviderIntegration | undefined;
const tag = argument("--tag");
const artifact = argument("--artifact");
const appPath = resolve(argument("--app") ?? "/Applications/F5.app");
if (!integration || !(integration in PROVIDER_INTEGRATION_RECORDS) || !tag || !artifact)
  throw new Error(
    "Usage: integrations:accept --integration <claude-chrome|codex-chrome|codex-computer> --tag <vX.Y.Z> --artifact <dmg>",
  );
if (process.platform !== "darwin") throw new Error("Acceptance runs on macOS only.");
if (process.env.F5_AGENT_PROCESS === "1")
  throw new Error("Run acceptance from Terminal, not from an F5 agent.");
const version = tag.replace(/^v/, "");
const expectedName = macArtifactName(version, process.arch);
if (basename(artifact) !== expectedName)
  throw new Error(`Expected the draft's ${expectedName}, got ${basename(artifact)}.`);

const run = (command: string, args: ReadonlyArray<string>) =>
  execFileSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
/** codesign prints its details on stderr. */
const cdhash = (app: string) => {
  const result = spawnSync("codesign", ["-dvvv", app], { encoding: "utf8" });
  const hash = result.status === 0 ? cdhashFromCodesign(result.stderr) : undefined;
  if (!hash) throw new Error(`codesign could not read the CDHash of ${app}.`);
  return hash;
};
const appVersion = (app: string) =>
  run("plutil", [
    "-extract",
    "CFBundleShortVersionString",
    "raw",
    join(app, "Contents/Info.plist"),
  ]).trim();

const artifactSha256 = await new Promise<string>((resolveHash, reject) => {
  const hash = createHash("sha256");
  createReadStream(artifact)
    .on("data", (chunk) => hash.update(chunk))
    .on("error", reject)
    .on("end", () => resolveHash(hash.digest("hex")));
});
const mount = await mkdtemp(join(tmpdir(), "f5-accept-"));
try {
  run("hdiutil", [
    "attach",
    "-readonly",
    "-nobrowse",
    "-noautoopen",
    "-mountpoint",
    mount,
    artifact,
  ]);
  try {
    const mounted = join(mount, "F5.app");
    if (cdhash(mounted) !== cdhash(appPath))
      throw new Error(
        `${appPath} is not the app in ${expectedName}. Install the draft's DMG first.`,
      );
    if (appVersion(appPath) !== version)
      throw new Error(`${appPath} is version ${appVersion(appPath)}, not ${version}.`);
  } finally {
    run("hdiutil", ["detach", mount]);
  }
} finally {
  await rm(mount, { recursive: true, force: true });
}

// The records the release embeds come from the tag's tree, not this checkout.
const sourceCommit = run("git", ["rev-list", "-n", "1", tag]).trim();
const tagged = JSON.parse(
  run("git", ["show", `${tag}:packages/shared/src/certification/${integration}.generated.json`]),
) as ProviderIntegrationRecord[];
const certifying = tagged.filter(
  (record) =>
    record.platform === process.platform && record.arch === process.arch && recordCertifies(record),
);
if (!certifying.length)
  throw new Error(`${tag} certifies no ${integration} record for darwin-${process.arch}.`);

const fixture = await startMutationServer();
const rl = createInterface({ input: process.stdin, output: process.stdout });
let outcome;
try {
  outcome = await runAcceptanceChecklist(
    { record: certifying.at(-1)!, userHome: homedir(), appPath, fixture },
    {
      say: (text) => console.log(text),
      confirm: async (question) =>
        /^y(es)?$/i.test((await rl.question(`${question} [y/n] `)).trim()),
      processes: async () =>
        run("ps", ["-axo", "pid=,ppid=,pgid=,command="])
          .split("\n")
          .map((line) => /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/.exec(line))
          .filter((match): match is RegExpExecArray => match !== null)
          .map(
            (match): AcceptanceProcess => ({
              pid: Number(match[1]),
              ppid: Number(match[2]),
              pgid: Number(match[3]),
              command: match[4]!,
            }),
          ),
      readFile: (path) => readFile(path, "utf8").catch(() => null),
      sleep: (ms) => new Promise((done) => setTimeout(done, ms)),
      now: Date.now,
    },
  );
} finally {
  rl.close();
  await fixture.close();
}

const report: IntegrationAcceptanceReport & { readonly observations: Record<string, unknown> } = {
  kind: "acceptance",
  integration,
  tag,
  platform: process.platform,
  arch: process.arch,
  artifactName: expectedName,
  artifactSha256,
  recordIds: certifying.map((record) => record.id),
  sourceCommit,
  checks: outcome.checks,
  observations: outcome.observations,
};
const output = resolve(root, argument("--output") ?? acceptanceReportPath(version, integration));
await writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
const failed = Object.entries(outcome.checks).filter(([, passed]) => !passed);
if (failed.length) {
  console.error(`\nAcceptance FAILED (${failed.map(([id]) => id).join(", ")}). Wrote ${output}.`);
  console.error("Do not promote. Withdraw the record and cut a new release.");
  process.exitCode = 1;
} else {
  console.log(`\nAcceptance passed. Commit ${output} to main, then run:`);
  console.log(`  bun run release:promote --tag ${tag}`);
}
