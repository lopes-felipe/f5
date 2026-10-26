/**
 * Generates the Claude in Chrome certification record from the bundled Claude CLI.
 *
 *   bun apps/server/scripts/generate-claude-chrome-descriptor.ts [--check] [--binary <path>]
 *     [--evidence docs/computer-certification/<id>.json [--reinstate]]
 *     [--withdraw <id> --reason <note>]
 *
 * Static facts come from the shipped executable; `toolNames`, `evidenceId` and
 * `evidenceCommit` are stamped only from a live report (run outside F5, on a clean commit)
 * whose versions match. `--check` fails on drift without writing. Never launches the CLI.
 */
import { execFileSync } from "node:child_process";
import { open, readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { readCodeSignature } from "@t3tools/shared/codeSignature";
import {
  type ClaudeChromeRecord,
  type IntegrationEvidenceReport,
} from "@t3tools/shared/providerIntegrationCertification";
import {
  CLAUDE_CHROME_BROWSER_BUNDLE_IDS,
  extractClaudeChromeDescriptor,
  type DescriptorSource,
} from "../src/provider/claudeChromeDescriptorExtraction";
import { mergeIntegrationRecords } from "../src/provider/integrationRecordMerge";
import { resolveBundledClaudeExecutable } from "../src/provider/claudeSdkExecutable";

const root = resolve(import.meta.dirname, "../../..");
const outputPath = join(root, "packages/shared/src/certification/claude-chrome.generated.json");
const argument = (name: string) => {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
};
const check = process.argv.includes("--check");
const platform = "darwin" as const;
const arch = argument("--arch") ?? "arm64";
const binary = await realpath(
  argument("--binary") ?? resolveBundledClaudeExecutable(platform, arch as NodeJS.Architecture),
);
const platformPackage = `@anthropic-ai/claude-agent-sdk-${platform}-${arch}`;
const sdkVersion = (
  JSON.parse(await readFile(join(dirname(binary), "package.json"), "utf8")) as { version: string }
).version;
const pinned = (
  JSON.parse(await readFile(join(root, "apps/server/package.json"), "utf8")) as {
    dependencies: Record<string, string>;
  }
).dependencies["@anthropic-ai/claude-agent-sdk"];
if (sdkVersion !== pinned)
  throw new Error(
    `Bundled ${platformPackage} ${sdkVersion} does not match the pinned SDK ${pinned}.`,
  );

const handle = await open(binary, "r");
let descriptor;
try {
  const size = (await handle.stat()).size;
  const source: DescriptorSource = {
    size,
    read: async (offset, length) => {
      const buffer = Buffer.alloc(Math.max(0, Math.min(length, size - offset)));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
      return buffer.subarray(0, bytesRead);
    },
  };
  descriptor = await extractClaudeChromeDescriptor(source);
} finally {
  await handle.close();
}
const signature = await readCodeSignature(binary);
const teamId = signature.ok ? signature.teamId : argument("--team");
if (!teamId) throw new Error("Could not read the Claude executable's signing team (pass --team).");

const browsers = descriptor.browsers.map((browser) => {
  const bundleId = CLAUDE_CHROME_BROWSER_BUNDLE_IDS[browser.id];
  if (!bundleId) throw new Error(`Unknown browser key ${browser.id}; add its bundle id.`);
  return { id: browser.id, bundleId, nativeMessagingPath: browser.nativeMessagingPath };
});
let record: ClaudeChromeRecord = {
  integration: "claude-chrome",
  id: `claude-chrome-${platform}-${arch}-${descriptor.cliVersion}`,
  platform,
  arch,
  versions: { sdkVersion, cliVersion: descriptor.cliVersion },
  identity: {
    teamId,
    platformPackage,
    hostName: descriptor.hostName,
    hostDescription: descriptor.hostDescription,
    allowedOrigins: descriptor.allowedOrigins,
    wrapperPath: descriptor.wrapperPath,
    wrapperHeader: descriptor.wrapperHeader,
    nativeHostArgs: descriptor.nativeHostArgs,
    mcpServerName: descriptor.mcpServerName,
    mcpArgs: descriptor.mcpArgs,
  },
  browsers,
  profileIsolation: "isolated",
};

const evidencePath = argument("--evidence");
const existing = JSON.parse(
  await readFile(outputPath, "utf8").catch(() => "[]"),
) as ClaudeChromeRecord[];
// Retiring a record is explicit (`--withdraw <id> --reason <note>`), so `sdk:audit` keeps
// failing until a withdrawal with its CHANGELOG note is recorded.
const withdrawId = argument("--withdraw");
const withdrawReason = argument("--reason");
if (withdrawId && !withdrawReason)
  throw new Error("--withdraw needs --reason, matching the CHANGELOG note.");
const next = mergeIntegrationRecords({
  existing,
  record,
  ...(evidencePath
    ? {
        report: JSON.parse(
          await readFile(resolve(evidencePath), "utf8"),
        ) as IntegrationEvidenceReport,
      }
    : {}),
  reinstate: process.argv.includes("--reinstate"),
  ...(withdrawId ? { withdraw: { id: withdrawId, reason: withdrawReason! } } : {}),
});
record = next.find((entry) => entry.id === record.id)!;
const current = await readFile(outputPath, "utf8").catch(() => "");
// Compared as data: the repository formatter owns the file's layout.
const canonical = (text: string) => {
  try {
    return JSON.stringify(JSON.parse(text));
  } catch {
    return undefined;
  }
};
if (check) {
  if (canonical(current) !== JSON.stringify(next)) {
    console.error("Claude Chrome descriptor drifted from the bundled CLI. Regenerate it:");
    console.error("  bun apps/server/scripts/generate-claude-chrome-descriptor.ts");
    process.exitCode = 1;
  } else console.log(`Claude Chrome descriptor matches CLI ${descriptor.cliVersion}.`);
} else {
  await writeFile(outputPath, `${JSON.stringify(next, null, 2)}\n`);
  // Leave the file as `bun fmt` would, so `fmt:check` stays clean.
  execFileSync(process.execPath, [join(root, "node_modules/oxfmt/bin/oxfmt"), outputPath], {
    cwd: root,
    stdio: "ignore",
  });
  console.log(
    `Wrote ${record.id}${record.evidenceId ? ` (evidence ${record.evidenceId})` : " (uncertified)"}.`,
  );
}
