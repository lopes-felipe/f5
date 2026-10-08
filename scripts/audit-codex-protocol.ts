import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  auditCodexResponseFields,
  diffCodexProtocolSurface,
  extractCodexTaggedUnionValues,
  isExpectedCodexProtocolVersion,
} from "@t3tools/shared/codexProtocolAudit";
import { parseCodexCliVersion } from "@t3tools/shared/codexCliVersion";
import {
  CODEX_DECODED_RESPONSE_FIELDS,
  CODEX_PROTOCOL_BASELINE_VERSION,
} from "@t3tools/shared/codexProtocolManifest";

const FIXTURE_PATH = path.resolve(
  import.meta.dirname,
  "fixtures/codex-protocol",
  `${CODEX_PROTOCOL_BASELINE_VERSION}.json`,
);
/** Generated TypeScript files that define the classified protocol surface. */
const SURFACE_FILES = [
  "ServerNotification.ts",
  "ServerRequest.ts",
  "ClientRequest.ts",
  "v2/ThreadItem.ts",
] as const;

interface CodexProtocolFixture {
  readonly cliVersion: string;
  readonly sourceRevision: string;
  readonly experimental: boolean;
  readonly sha256: Record<string, string>;
}

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

async function runCommand(command: string, args: ReadonlyArray<string>): Promise<string> {
  const process = Bun.spawn([command, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    process.exited,
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
  ]);
  if (exitCode !== 0) {
    throw new Error(stderr.trim() || `${command} exited with status ${exitCode}`);
  }
  return stdout.trim();
}

function printDrift(
  label: string,
  count: number,
  drift: { readonly added: ReadonlyArray<string>; readonly removed: ReadonlyArray<string> },
): void {
  console.log(`${label}: ${count}`);
  for (const value of drift.added) {
    console.log(`  + ${value}`);
  }
  for (const value of drift.removed) {
    console.log(`  - ${value}`);
  }
}

async function main(): Promise<void> {
  const temporaryDirectories: string[] = [];
  try {
    let binary = process.env.CODEX_BINARY_PATH?.trim() || "codex";
    if (process.argv.includes("--install-baseline")) {
      const installDirectory = await mkdtemp(path.join(tmpdir(), "f5-codex-protocol-cli-"));
      temporaryDirectories.push(installDirectory);
      await runCommand("npm", [
        "install",
        "--prefix",
        installDirectory,
        "--no-save",
        `@openai/codex@${CODEX_PROTOCOL_BASELINE_VERSION}`,
      ]);
      binary = path.join(
        installDirectory,
        "node_modules",
        ".bin",
        process.platform === "win32" ? "codex.cmd" : "codex",
      );
    }

    const outputDirectory = await mkdtemp(path.join(tmpdir(), "f5-codex-protocol-audit-"));
    temporaryDirectories.push(outputDirectory);
    const schemaDirectory = await mkdtemp(path.join(tmpdir(), "f5-codex-protocol-schema-"));
    temporaryDirectories.push(schemaDirectory);
    const installedVersion = await runCommand(binary, ["--version"]);
    await runCommand(binary, [
      "app-server",
      "generate-ts",
      "--out",
      outputDirectory,
      "--experimental",
    ]);
    await runCommand(binary, [
      "app-server",
      "generate-json-schema",
      "--out",
      schemaDirectory,
      "--experimental",
    ]);

    const [notificationSource, requestSource, itemSource, clientRequestSource] = await Promise.all([
      readFile(path.join(outputDirectory, "ServerNotification.ts"), "utf8"),
      readFile(path.join(outputDirectory, "ServerRequest.ts"), "utf8"),
      readFile(path.join(outputDirectory, "v2", "ThreadItem.ts"), "utf8"),
      readFile(path.join(outputDirectory, "ClientRequest.ts"), "utf8"),
    ]);
    const actual = {
      notifications: extractCodexTaggedUnionValues(notificationSource, "method"),
      requests: extractCodexTaggedUnionValues(requestSource, "method"),
      items: extractCodexTaggedUnionValues(itemSource, "type"),
      clientRequests: extractCodexTaggedUnionValues(clientRequestSource, "method"),
    };
    const report = diffCodexProtocolSurface(actual);

    // Layer 2: field-level certification for the responses F5 decodes.
    const schemaSources = new Map<string, string>();
    await Promise.all(
      Object.values(CODEX_DECODED_RESPONSE_FIELDS).map(async ({ schema: schemaFile }) => {
        const source = await readFile(path.join(schemaDirectory, schemaFile), "utf8").catch(
          () => undefined,
        );
        if (source !== undefined) schemaSources.set(schemaFile, source);
      }),
    );
    const responseReport = auditCodexResponseFields((schemaFile) => {
      const source = schemaSources.get(schemaFile);
      return source === undefined ? undefined : JSON.parse(source);
    }, new Set(actual.clientRequests));
    const surfaceSources = new Map<string, string>();
    await Promise.all(
      SURFACE_FILES.map(async (file) => {
        surfaceSources.set(file, await readFile(path.join(outputDirectory, file), "utf8"));
      }),
    );
    const checksums = Object.fromEntries(
      [...surfaceSources, ...schemaSources]
        .map(([file, source]) => [file, sha256(source)] as const)
        .toSorted(([left], [right]) => left.localeCompare(right)),
    );
    const installedProtocolVersion = parseCodexCliVersion(installedVersion);
    const hasVersionMismatch = !isExpectedCodexProtocolVersion(
      installedVersion,
      CODEX_PROTOCOL_BASELINE_VERSION,
    );

    console.log(`Codex protocol audit: ${installedVersion}`);
    console.log(`Checked baseline: ${CODEX_PROTOCOL_BASELINE_VERSION}`);
    printDrift("Notifications", actual.notifications.length, report.notifications);
    printDrift("Server requests", actual.requests.length, report.requests);
    printDrift("Thread items", actual.items.length, report.items);
    console.log(
      `Decoded response fields: ${Object.values(CODEX_DECODED_RESPONSE_FIELDS).flatMap((entry) => entry.fields).length} certified`,
    );
    for (const skipped of responseReport.skippedMethods)
      console.log(`  - ${skipped} (not offered)`);
    for (const missing of responseReport.missingSchemas) console.log(`  ! schema ${missing}`);
    for (const missing of responseReport.missingFields) console.log(`  ! field ${missing}`);
    console.log(
      `Client requests used by F5: ${report.clientRequests.unsupported.length} unsupported`,
    );
    for (const group of report.clientRequests.unsupported) {
      console.log(`  ! ${group}`);
    }
    for (const fallback of report.clientRequests.usingFallback) {
      console.log(`  ~ ${fallback} (fallback)`);
    }

    if (hasVersionMismatch) {
      console.error(
        installedProtocolVersion
          ? `Codex version mismatch: expected ${CODEX_PROTOCOL_BASELINE_VERSION}, received ${installedProtocolVersion}.`
          : `Unable to parse a Codex version from: ${installedVersion}`,
      );
    }
    if (report.clientRequests.unsupported.length > 0) {
      console.error(
        "This CLI rejects requests F5 sends. Add a fallback or update the client before supporting it.",
      );
    }
    if (report.hasDrift) {
      console.error(
        "Protocol drift detected. Classify every added surface before updating the manifest.",
      );
    }
    const responseDrift =
      responseReport.missingFields.length > 0 || responseReport.missingSchemas.length > 0;
    if (responseDrift) {
      console.error("A response field F5 decodes is missing from the generated schema.");
    }

    let checksumDrift = false;
    if (!hasVersionMismatch) {
      if (process.argv.includes("--write-fixture")) {
        const sourceRevision = process.env.CODEX_SOURCE_REVISION?.trim();
        if (!sourceRevision) {
          throw new Error("Set CODEX_SOURCE_REVISION to the release's source commit.");
        }
        const fixture: CodexProtocolFixture = {
          cliVersion: CODEX_PROTOCOL_BASELINE_VERSION,
          sourceRevision,
          experimental: true,
          sha256: checksums,
        };
        await writeFile(FIXTURE_PATH, `${JSON.stringify(fixture, null, 2)}\n`);
        console.log(`Wrote ${path.relative(process.cwd(), FIXTURE_PATH)}`);
      } else {
        const fixture = JSON.parse(await readFile(FIXTURE_PATH, "utf8")) as CodexProtocolFixture;
        for (const [file, checksum] of Object.entries(checksums)) {
          if (fixture.sha256[file] !== checksum) {
            checksumDrift = true;
            console.error(`  ~ generated ${file} differs from the committed fixture`);
          }
        }
        for (const file of Object.keys(fixture.sha256)) {
          if (!(file in checksums)) {
            checksumDrift = true;
            console.error(`  ~ fixture lists ${file}, which was not generated`);
          }
        }
        if (checksumDrift) {
          console.error(
            `Generated schemas differ from ${path.basename(FIXTURE_PATH)} (source ${fixture.sourceRevision}). Re-certify and refresh with --write-fixture.`,
          );
        }
      }
    }

    if (hasVersionMismatch || report.hasDrift || responseDrift || checksumDrift) {
      process.exitCode = 1;
      return;
    }
    console.log("No protocol drift detected.");
  } finally {
    await Promise.all(
      temporaryDirectories.map((directory) => rm(directory, { recursive: true, force: true })),
    );
  }
}

await main();
