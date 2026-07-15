import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  diffCodexProtocolSurface,
  extractCodexTaggedUnionValues,
  isExpectedCodexProtocolVersion,
} from "@t3tools/shared/codexProtocolAudit";
import { parseCodexCliVersion } from "@t3tools/shared/codexCliVersion";
import { CODEX_PROTOCOL_BASELINE_VERSION } from "@t3tools/shared/codexProtocolManifest";

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
    const installedVersion = await runCommand(binary, ["--version"]);
    await runCommand(binary, [
      "app-server",
      "generate-ts",
      "--out",
      outputDirectory,
      "--experimental",
    ]);

    const [notificationSource, requestSource, itemSource] = await Promise.all([
      readFile(path.join(outputDirectory, "ServerNotification.ts"), "utf8"),
      readFile(path.join(outputDirectory, "ServerRequest.ts"), "utf8"),
      readFile(path.join(outputDirectory, "v2", "ThreadItem.ts"), "utf8"),
    ]);
    const actual = {
      notifications: extractCodexTaggedUnionValues(notificationSource, "method"),
      requests: extractCodexTaggedUnionValues(requestSource, "method"),
      items: extractCodexTaggedUnionValues(itemSource, "type"),
    };
    const report = diffCodexProtocolSurface(actual);
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

    if (hasVersionMismatch) {
      console.error(
        installedProtocolVersion
          ? `Codex version mismatch: expected ${CODEX_PROTOCOL_BASELINE_VERSION}, received ${installedProtocolVersion}.`
          : `Unable to parse a Codex version from: ${installedVersion}`,
      );
    }
    if (report.hasDrift) {
      console.error(
        "Protocol drift detected. Classify every added surface before updating the manifest.",
      );
    }
    if (hasVersionMismatch || report.hasDrift) {
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
