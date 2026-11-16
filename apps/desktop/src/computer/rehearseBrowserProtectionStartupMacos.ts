import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { release, tmpdir } from "node:os";
import { promisify } from "node:util";
import { createBrowserProtectionFixture } from "./rehearsalBrowserFixture";
import { protectionChromeArguments } from "./rehearsalProtection";

// Headless local-fixture setup only: no helper, grants, capture, accessibility,
// OS input, provider session or real browser profile/keychain. Operator may work.
const args = process.argv.slice(2);
const index = args.indexOf("--output");
const output = index < 0 ? undefined : args[index + 1];
if (process.platform !== "darwin" || !output) {
  process.stderr.write(
    "Usage: bun apps/desktop/src/computer/rehearseBrowserProtectionStartupMacos.ts --output <new report.json>\n",
  );
  process.exit(1);
}
await writeFile(resolve(output), "", { flag: "wx" });
const root = await mkdtemp(join(tmpdir(), "f5-headless-protection-startup-"));
const binary = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const exec = promisify(execFile);
let fixture: Awaited<ReturnType<typeof createBrowserProtectionFixture>> | undefined;
let metadata: Record<string, unknown> = {};
let launchCompleted = false;
let fixtureInDom = false;
try {
  const repo = resolve(import.meta.dirname, "../../../..");
  const sourceHashes = Object.fromEntries(
    await Promise.all(
      [
        ["startup", import.meta.filename],
        ["fixture", join(import.meta.dirname, "rehearsalBrowserFixture.ts")],
        ["protection", join(import.meta.dirname, "rehearsalProtection.ts")],
        ["chromeExecutable", binary],
      ].map(async ([name, file]) => [
        name!,
        createHash("sha256")
          .update(await readFile(file!))
          .digest("hex"),
      ]),
    ),
  );
  const version = (
    await exec(
      "/usr/libexec/PlistBuddy",
      [
        "-c",
        "Print :CFBundleShortVersionString",
        "/Applications/Google Chrome.app/Contents/Info.plist",
      ],
      { timeout: 5000, maxBuffer: 1024 },
    )
  ).stdout.trim();
  if (!/^\d{1,4}(\.\d{1,8}){1,4}$/.test(version)) throw new Error("Invalid version metadata.");
  metadata = {
    repositoryCommit: (await exec("git", ["rev-parse", "HEAD"], { cwd: repo })).stdout.trim(),
    workingTreeDirty: Boolean(
      (await exec("git", ["status", "--porcelain"], { cwd: repo })).stdout.trim(),
    ),
    chromeVersion: version,
    sourceHashes,
  };
  fixture = await createBrowserProtectionFixture();
  const result = await exec(
    binary,
    protectionChromeArguments(join(root, "profile"), fixture.url, "headless"),
    { timeout: 15000, maxBuffer: 65536 },
  );
  launchCompleted = true;
  fixtureInDom = result.stdout.includes("F5 browser protection fixture");
} catch {
  /* No raw errors, page content or process arguments leave the probe. */
} finally {
  await fixture?.close();
  await rm(root, { recursive: true, force: true });
  const observation = fixture?.observation();
  const state = fixture?.state();
  const checks = {
    launchCompleted,
    fixtureInDom,
    fixtureRequested: observation?.pageRequested === true,
    independentReadyObservation: observation?.stateReported === true && state?.ready === true,
    noRejectedObservations: observation?.stateRejected === false,
    syntheticValueUnchanged: state?.secureUnchanged === true && state.inputEvents === 0,
  };
  const passed = Object.values(checks).every(Boolean);
  await writeFile(
    resolve(output),
    JSON.stringify(
      {
        reportVersion: 1,
        recordedAt: new Date().toISOString(),
        ...metadata,
        platform: process.platform,
        arch: process.arch,
        osVersion: release(),
        scope: "headless-isolated-chrome-fixture-startup-only",
        mockKeychain: true,
        signed: false,
        certified: false,
        state: passed ? "passed" : "failed",
        checks,
        limitations: [
          "No desktop window, helper, grants, provider, accessibility, capture, masking or OS input exercised",
          "Test-only mock keychain and temporary local profile; real keychain/autofill and signed-in browser behavior unproven",
          "Setup diagnostic only; all release certification gates remain closed",
        ],
      },
      null,
      2,
    ) + "\n",
  );
  process.stdout.write(
    `Headless protection startup: ${passed ? "passed" : "failed"}; report ${resolve(output)}\n`,
  );
  if (!passed) process.exitCode = 1;
}
