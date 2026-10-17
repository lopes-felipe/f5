import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import {
  formatProviderUpdateCommand,
  formatProviderInstallChannel,
  formatProviderUpdateCheckAge,
  hasProviderUpdateNotification,
  getProviderUpdateResultMessage,
} from "./providerStatus";

const baseProvider: ServerProvider = {
  instanceId: ProviderInstanceId.make("codex"),
  driver: ProviderDriverKind.make("codex"),
  enabled: true,
  installed: true,
  version: "1.0.0",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-05-26T00:00:00.000Z",
  models: [],
  slashCommands: [],
  skills: [],
};

const updateCommand = {
  executable: "npm",
  args: ["install", "-g", "@openai/codex@latest"],
  channel: "npm",
} as const;

describe("provider update advisory presentation", () => {
  it("formats structured update commands for copy", () => {
    expect(formatProviderUpdateCommand(updateCommand)).toBe("npm install -g @openai/codex@latest");
  });

  it("quotes unsafe argv when formatting copy text", () => {
    expect(
      formatProviderUpdateCommand({
        executable: "npm",
        args: ["install", "-g", "@scope/package with spaces@latest", "needs'quote"],
        channel: "npm",
      }),
    ).toBe("npm install -g '@scope/package with spaces@latest' 'needs'\\''quote'");
  });
});

describe("installation update presentations", () => {
  it("quotes PowerShell executable paths, arguments and env values", () => {
    expect(
      formatProviderUpdateCommand({
        executable: "C:\\Program Files\\npm.cmd",
        args: ["install", "-g", "needs'quote"],
        channel: "npm",
        shell: "powershell",
        env: { NPM_CONFIG_PREFIX: "C:\\O'Brien" },
      }),
    ).toBe(
      "$env:NPM_CONFIG_PREFIX='C:\\O''Brien'; & 'C:\\Program Files\\npm.cmd' 'install' '-g' 'needs''quote'",
    );
  });
  it("explains each install source and check age", () => {
    expect(formatProviderInstallChannel("homebrew")).toBe("Homebrew");
    expect(formatProviderInstallChannel("bundled")).toBe("Bundled with F5");
    expect(formatProviderInstallChannel("self-update")).toBe("built-in updater");
    expect(formatProviderInstallChannel("unmanaged")).toContain("doesn't recognize");
    expect(formatProviderUpdateCheckAge(null)).toBe("Not checked yet");
    expect(
      formatProviderUpdateCheckAge("2026-10-17T00:00:00Z", Date.parse("2026-10-17T00:30:00Z")),
    ).toBe("Last checked 30m ago");
  });
  it("dismisses only update notifications, keeps bundled quiet, and requires a known newer release", () => {
    const advisory = {
      status: "check_failed" as const,
      updateAvailable: true,
      currentVersion: "1.0.0",
      latestVersion: "1.1.0",
      updateCommand: null,
      checkedAt: null,
      message: "offline",
    };
    expect(hasProviderUpdateNotification(advisory)).toBe(true);
    expect(hasProviderUpdateNotification(advisory, "1.1.0")).toBe(false);
    expect(hasProviderUpdateNotification({ ...advisory, latestVersion: null })).toBe(false);
    expect(hasProviderUpdateNotification({ ...advisory, updateAvailable: false })).toBe(false);
    expect(hasProviderUpdateNotification({ ...advisory, status: "bundled" })).toBe(false);
  });
  it("explains unchanged, unexpected, unverified and failed updates", () => {
    const result = {
      instanceId: baseProvider.instanceId,
      previousVersion: "1.0.0",
      currentVersion: "1.0.0",
      exitCode: 0,
      timedOut: false,
      output: "",
      outputTruncated: false,
      providers: [],
    };
    expect(
      getProviderUpdateResultMessage({ ...result, outcome: "unchanged" }, "Homebrew", "1.1.0"),
    ).toContain("Homebrew may not have published v1.1.0 yet");
    expect(
      getProviderUpdateResultMessage({ ...result, outcome: "unexpected_version" }, "npm", "1.1.0"),
    ).toBe("Installed v1.0.0, expected v1.1.0.");
    expect(
      getProviderUpdateResultMessage({ ...result, outcome: "unverified" }, "npm", "1.1.0"),
    ).toContain("couldn't confirm");
    expect(
      getProviderUpdateResultMessage(
        { ...result, outcome: "failed", timedOut: true },
        "npm",
        "1.1.0",
      ),
    ).toContain("timed out");
  });
});

it("routes a copied npm command through the installation's Node before the terminal PATH", () => {
  expect(
    formatProviderUpdateCommand({
      executable: "/nvm/selected/bin/npm",
      args: ["install", "-g", "@openai/codex@1.0.0"],
      channel: "npm",
      shell: "posix",
      pathPrepend: "/nvm/selected/bin",
      env: { NPM_CONFIG_PREFIX: "/nvm/selected" },
    }),
  ).toBe(
    'NPM_CONFIG_PREFIX=/nvm/selected PATH=/nvm/selected/bin:"$PATH" /nvm/selected/bin/npm install -g @openai/codex@1.0.0',
  );
});

it.skipIf(process.platform === "win32")(
  "uses the installation Node even with another Node first in the terminal PATH",
  () => {
    const root = mkdtempSync(join(tmpdir(), "f5-copy-command-"));
    const bin = join(root, "selected node", "bin");
    const terminalBin = join(root, "terminal-bin");
    try {
      mkdirSync(bin, { recursive: true });
      mkdirSync(terminalBin);
      writeFileSync(join(bin, "node"), "#!/bin/sh\necho installation-node\n", { mode: 0o755 });
      writeFileSync(join(terminalBin, "node"), "#!/bin/sh\necho wrong-terminal-node\n", {
        mode: 0o755,
      });
      writeFileSync(join(bin, "npm"), "#!/usr/bin/env node\n", { mode: 0o755 });
      const command = formatProviderUpdateCommand({
        executable: join(bin, "npm"),
        args: ["install", "-g", "@openai/codex@1.1.0"],
        channel: "npm",
        shell: "posix",
        pathPrepend: bin,
        env: { NPM_CONFIG_PREFIX: join(root, "selected node") },
      });
      expect(
        execFileSync("/bin/sh", ["-c", command], {
          env: { ...process.env, PATH: terminalBin },
          encoding: "utf8",
        }).trim(),
      ).toBe("installation-node");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);
