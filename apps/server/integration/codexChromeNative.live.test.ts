import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  INTEGRATION_REQUIRED_ASSERTIONS,
  PROVIDER_INTEGRATION_RECORDS,
  integrationTemplateRecord,
  type IntegrationEvidenceReport,
} from "@t3tools/shared/providerIntegrationCertification";

import {
  codexChromeChildEnvironment,
  codexChromeRegistrationsUnchanged,
  inspectCodexChrome,
} from "../src/computer/codexNativeIntegrations";
import { IntegrationProxySession, type IntegrationTool } from "../src/mcp/IntegrationProxyCatalog";
import { evidenceSource } from "./fixtures/evidenceSource";
import {
  DEFAULT_QUIET_WINDOW,
  startMutationServer,
  stoppedAfter,
} from "../../../scripts/lib/mutation-fixture.ts";

/**
 * Live Codex Chrome certification run through F5's proxy, outside F5, on a clean commit.
 * It needs ChatGPT.app with its Chrome extension set up and Chrome running. It never
 * stamps a record: it writes a report for `stamp-integration-record.ts`, with the exercised
 * versions (stamped as floors), the observed inventory, its schemas and the commit.
 *
 * F5_CODEX_NATIVE_LIVE=chrome opts in; F5_CODEX_CHROME_REPORT=<file> receives the report
 * and F5_CODEX_CHROME_EVIDENCE_ID names it.
 */
const optedIn = process.env.F5_CODEX_NATIVE_LIVE === "chrome";
const text = (result: { content: ReadonlyArray<{ type: string; text?: string }> }) =>
  result.content.map((block) => block.text ?? "").join("");

describe.skipIf(!optedIn)("Codex Chrome live certification", () => {
  it("opens a tab through the proxy, drains an interrupt, stops background work on pause and leaves registrations unchanged", async () => {
    if (process.env.F5_AGENT_PROCESS === "1")
      throw new Error("Run the Codex Chrome certification outside F5, not from an F5 agent.");
    if (process.platform !== "darwin") throw new Error("Codex Chrome certification is macOS only.");
    // Only the static identity is used; versions and inventory come from this run. The
    // stamper defaults to the same template, so the identity exercised is the one stamped.
    const record = integrationTemplateRecord(
      PROVIDER_INTEGRATION_RECORDS["codex-chrome"],
      process.platform,
      process.arch,
    );
    if (!record) throw new Error(`No Codex Chrome record for darwin-${process.arch}.`);
    // Taken before anything runs; the report file written at the end doesn't count.
    const source = evidenceSource();
    const userHome = userInfo().homedir;
    // Certification exercises whatever ChatGPT is installed: every identity, signature,
    // origin and helper check still applies, and the run's versions become the floors.
    const installation = await inspectCodexChrome({
      userHome,
      record: { ...record, versions: { appMin: "0", pluginMin: "0" } },
    });
    if (!installation.available) throw new Error(installation.reason);
    const observations: Record<string, unknown> = {};
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
    const fixture = await startMutationServer();
    // The stamper records what this run observed; an older record's digest is not the bar.
    const session = open(observed.sha256);
    try {
      const names = observed.tools.map((tool) => tool.name);
      assertions["tool-inventory"] =
        record.identity.allowedTools.every((name) => names.includes(name)) &&
        (await session.verifyInventory().then(
          () => true,
          () => false,
        ));
      observations.inventoryChangedFromRecord =
        record.toolInventorySha256 !== undefined && record.toolInventorySha256 !== observed.sha256;

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

      // Work an earlier call left running (a timer driving a tab) must stop on pause,
      // which cancels calls and stops the child. The fixture counts every navigation.
      const marker = "codex-background";
      const background = await session.callTool("js", {
        code: `${setup}
const tab = await chrome.tabs.new();
let n = 0;
globalThis.__f5Background = setInterval(() => {
  tab.goto(${JSON.stringify(`${fixture.origin}/marker/${marker}`)} + "?n=" + n++).catch(() => {});
}, 250);
nodeRepl.write("started");`,
      });
      expect(background.isError, text(background)).not.toBe(true);
      const runningBy = Date.now() + 15_000;
      while (
        fixture.hits(marker).length < DEFAULT_QUIET_WINDOW.minHitsBefore &&
        Date.now() < runningBy
      )
        await new Promise((resolve) => setTimeout(resolve, 100));
      const stoppedAt = Date.now();
      session.cancel();
      await new Promise((resolve) =>
        setTimeout(resolve, DEFAULT_QUIET_WINDOW.settleMs + DEFAULT_QUIET_WINDOW.quietMs + 250),
      );
      const hits = fixture.hits(marker);
      assertions["background-work-stops-on-pause"] = stoppedAfter(hits, stoppedAt, Date.now());
      observations["background-work-stops-on-pause"] = {
        hitsBeforePause: hits.filter((time) => time <= stoppedAt).length,
        hitsAfterPause: hits.filter((time) => time > stoppedAt).length,
        lastHitAfterPauseMs: Math.max(0, (hits.at(-1) ?? stoppedAt) - stoppedAt),
      };

      assertions["registrations-unchanged"] = await codexChromeRegistrationsUnchanged(
        installation,
        userHome,
      );
    } finally {
      await session.dispose();
      await fixture.close();
      await rm(codexHome, { recursive: true, force: true });
    }

    const report: IntegrationEvidenceReport & { readonly observations: Record<string, unknown> } = {
      integration: "codex-chrome",
      evidenceId: process.env.F5_CODEX_CHROME_EVIDENCE_ID ?? "uncommitted",
      platform: process.platform,
      arch: process.arch,
      // The exercised versions, stamped as the record's floors.
      versions: { appMin: installation.appVersion, pluginMin: installation.pluginVersion },
      assertions,
      toolNames: observed.tools.map((tool) => tool.name),
      toolInventorySha256: observed.sha256,
      toolSchemas: observed.tools.map(({ name, description, inputSchema }) => ({
        name,
        ...(description !== undefined ? { description } : {}),
        inputSchema,
      })),
      ...source,
      observations,
    };
    if (process.env.F5_CODEX_CHROME_REPORT)
      await writeFile(process.env.F5_CODEX_CHROME_REPORT, `${JSON.stringify(report, null, 2)}\n`);
    expect(Object.entries(assertions).filter(([, passed]) => !passed)).toEqual([]);
  }, 300_000);
});
