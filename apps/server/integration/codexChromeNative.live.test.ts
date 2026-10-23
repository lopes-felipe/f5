import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  INTEGRATION_REQUIRED_ASSERTIONS,
  PROVIDER_INTEGRATION_RECORDS,
  type IntegrationEvidenceReport,
} from "@t3tools/shared/providerIntegrationCertification";

import {
  codexChromeChildEnvironment,
  codexChromeRegistrationsUnchanged,
  inspectCodexChrome,
} from "../src/computer/codexNativeIntegrations";
import { IntegrationProxySession, type IntegrationTool } from "../src/mcp/IntegrationProxyCatalog";

/**
 * Live Codex Chrome certification run through F5's proxy, outside F5. It needs ChatGPT.app
 * with its Chrome extension set up and Chrome running. It never stamps a record: it writes
 * a report for the operator gate, with the observed inventory hash and versions.
 *
 * F5_CODEX_NATIVE_LIVE=chrome opts in; F5_CODEX_CHROME_REPORT=<file> receives the report.
 */
const optedIn = process.env.F5_CODEX_NATIVE_LIVE === "chrome";
const text = (result: { content: ReadonlyArray<{ type: string; text?: string }> }) =>
  result.content.map((block) => block.text ?? "").join("");

describe.skipIf(!optedIn)("Codex Chrome live certification", () => {
  it("opens a tab through the proxy, drains an interrupt and leaves registrations unchanged", async () => {
    if (process.env.F5_AGENT_PROCESS === "1")
      throw new Error("Run the Codex Chrome certification outside F5, not from an F5 agent.");
    if (process.platform !== "darwin") throw new Error("Codex Chrome certification is macOS only.");
    const record = PROVIDER_INTEGRATION_RECORDS["codex-chrome"].find(
      (entry) => entry.platform === process.platform && entry.arch === process.arch,
    );
    if (!record) throw new Error(`No Codex Chrome record for darwin-${process.arch}.`);
    const userHome = userInfo().homedir;
    const installation = await inspectCodexChrome({ userHome, record });
    if (!installation.available) throw new Error(installation.reason);
    const codexHome = await mkdtemp(join(tmpdir(), "f5-codex-chrome-live-"));
    const assertions: Record<string, boolean> = Object.fromEntries(
      INTEGRATION_REQUIRED_ASSERTIONS["codex-chrome"].map((name) => [name, false]),
    );
    let observed: { sha256: string; tools: ReadonlyArray<IntegrationTool> } | undefined;
    const open = (inventory: string | undefined) =>
      new IntegrationProxySession({
        integration: "codex-chrome",
        threadId: "live-certification",
        generation: "live",
        command: installation.nodeRepl,
        args: [],
        env: codexChromeChildEnvironment(installation, codexHome, process.env),
        allowedTools: record.identity.allowedTools,
        toolInventorySha256: inventory,
        identity: {
          profileId: "live-certification",
          backendIncarnation: "live",
          threadId: "live-certification",
          sessionGeneration: "live",
          integration: "codex-chrome",
        },
        register: async () => {},
        inventoryObserved: (sha256, tools) => {
          observed = { sha256, tools };
        },
        policyEnabled: async () => true,
        currentGeneration: () => "live",
        paused: () => false,
        consent: async () => true,
        acquireLease: async () => {},
        releaseLease: () => {},
      });
    const setup = `const { setupBrowserRuntime } = await import(${JSON.stringify(
      join(installation.pluginRoot, "scripts/browser-client.mjs"),
    )});
const agent = await setupBrowserRuntime();
const chrome = await agent.browsers.get("chrome");`;
    const readTitle = `const tab = await chrome.tabs.new();
await tab.goto("https://example.com/");
nodeRepl.write(await tab.title());
await tab.close();`;

    // The record carries no inventory until this run supplies it; observe it first.
    const probe = open(undefined);
    // Without a recorded digest verification fails after reporting what was listed.
    await probe.verifyInventory().catch(() => undefined);
    await probe.dispose();
    if (!observed) throw new Error("node_repl listed no tools.");
    const session = open(record.toolInventorySha256 ?? observed.sha256);
    try {
      const names = observed.tools.map((tool) => tool.name);
      assertions["tool-inventory"] =
        record.identity.allowedTools.every((name) => names.includes(name)) &&
        (!record.toolInventorySha256 || record.toolInventorySha256 === observed.sha256);

      const first = await session.callTool("js", { code: `${setup}\n${readTitle}` });
      expect(first.isError, text(first)).not.toBe(true);
      assertions["open-tab-read-title"] = text(first).includes("Example Domain");

      const hung = session.callTool("js", {
        code: "await new Promise((resolve) => setTimeout(resolve, 60_000));",
      });
      await new Promise((resolve) => setTimeout(resolve, 1000));
      session.cancel();
      const cancelled = await hung;
      // A fresh tab claim after the drain proves the interrupt left none stuck.
      const after = await session.callTool("js", { code: `${setup}\n${readTitle}` });
      assertions["interrupt-drains"] =
        cancelled.isError === true &&
        session.inFlight.length === 0 &&
        text(after).includes("Example Domain");

      assertions["registrations-unchanged"] = await codexChromeRegistrationsUnchanged(
        installation,
        userHome,
      );
    } finally {
      await session.dispose();
      await rm(codexHome, { recursive: true, force: true });
    }

    const report: IntegrationEvidenceReport = {
      integration: "codex-chrome",
      evidenceId: process.env.F5_CODEX_CHROME_EVIDENCE_ID ?? "uncommitted",
      platform: process.platform,
      arch: process.arch,
      // Record ranges are stamped from the single exercised version.
      versions: {
        appMin: installation.appVersion,
        appMax: installation.appVersion,
        pluginMin: installation.pluginVersion,
        pluginMax: installation.pluginVersion,
      },
      assertions,
      toolNames: observed.tools.map((tool) => tool.name),
      toolInventorySha256: observed.sha256,
      ...(process.env.F5_CODEX_CHROME_ARTIFACT_SHA256
        ? { artifactSha256: process.env.F5_CODEX_CHROME_ARTIFACT_SHA256 }
        : {}),
    };
    if (process.env.F5_CODEX_CHROME_REPORT)
      await writeFile(process.env.F5_CODEX_CHROME_REPORT, `${JSON.stringify(report, null, 2)}\n`);
    expect(Object.entries(assertions).filter(([, passed]) => !passed)).toEqual([]);
  }, 300_000);
});
