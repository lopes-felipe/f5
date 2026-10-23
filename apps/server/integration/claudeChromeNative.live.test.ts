import * as NodeServices from "@effect/platform-node/NodeServices";
import { mkdtempSync } from "node:fs";
import { realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { query, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import {
  INTEGRATION_REQUIRED_ASSERTIONS,
  PROVIDER_INTEGRATION_RECORDS,
  type IntegrationEvidenceReport,
} from "@t3tools/shared/providerIntegrationCertification";

import { buildClaudeQueryEnv } from "../src/provider/Layers/ClaudeAdapter.ts";
import { createControllableAsyncIterable } from "../src/provider/Layers/ClaudeSdk.testUtils.ts";
import { claudeChromeDescriptor, type ChromeServerStatus } from "../src/provider/chromeNativeHost";
import { inspectChromeNativeHosts } from "../src/provider/chromeNativeHostInspection";
import { ChromeNativeHostTransactions } from "../src/provider/chromeNativeHostJournal";
import {
  makeChromeNativeHostStorage,
  readChromeArtifact,
} from "../src/provider/chromeNativeHostStorage";
import { resolveBundledClaudeExecutable } from "../src/provider/claudeSdkExecutable";

/**
 * Live Claude in Chrome certification run. It writes the real browser native-messaging
 * folders, so it must run on a real Mac outside F5 (an F5 agent sandbox cannot reach
 * them). It never stamps a record: it writes a scrubbed report that
 * `generate-claude-chrome-descriptor.ts --evidence` validates before stamping.
 *
 * F5_CLAUDE_CHROME_LIVE=1 opts in; F5_CLAUDE_CHROME_REPORT=<file> receives the report.
 */
const optedIn = process.env.F5_CLAUDE_CHROME_LIVE === "1";
describe.skipIf(!optedIn)("Claude in Chrome live certification", () => {
  it("launches, verifies, and restores the browser setup byte-for-byte", async () => {
    if (process.env.F5_AGENT_PROCESS === "1")
      throw new Error("Run the Claude in Chrome certification outside F5, not from an F5 agent.");
    if (process.platform !== "darwin")
      throw new Error("Claude in Chrome certification is macOS only.");
    const record = PROVIDER_INTEGRATION_RECORDS["claude-chrome"].find(
      (entry) => entry.platform === process.platform && entry.arch === process.arch,
    );
    if (!record) throw new Error(`No Claude in Chrome record for darwin-${process.arch}.`);
    const descriptor = claudeChromeDescriptor(record);
    const userHome = userInfo().homedir;
    const providerHome = process.env.CLAUDE_CONFIG_DIR ?? join(userHome, ".claude");
    const executable = await realpath(resolveBundledClaudeExecutable());
    const locations = descriptor.locations(providerHome, userHome);
    const stateDir = mkdtempSync(join(tmpdir(), "f5-claude-chrome-live-"));
    const storage = await Effect.runPromise(
      makeChromeNativeHostStorage({
        stateDir,
        inspect: () => inspectChromeNativeHosts(locations),
      }).pipe(Effect.provide(NodeServices.layer)),
    );
    const transactions = new ChromeNativeHostTransactions(storage);
    const targetPath = descriptor.expectedTarget(providerHome);
    const before = new Map<string, string | null>();
    for (const location of [
      ...locations.map((entry) => (entry.kind === "file" ? entry.path : "")),
      targetPath,
    ])
      before.set(location, (await readChromeArtifact(location)).bytes);

    const assertions: Record<string, boolean> = Object.fromEntries(
      INTEGRATION_REQUIRED_ASSERTIONS["claude-chrome"].map((name) => [name, false]),
    );
    const approved = await transactions.approve({
      provider: "claude",
      profileId: "live-certification",
      providerInstanceId: "claudeAgent",
      recordId: record.id,
      providerHome,
      userHome,
      targetPath,
      wrapperLocation: targetPath,
      observed: await storage.inspect(),
      acceptedForeign: [],
    });
    const cwd = mkdtempSync(join(tmpdir(), "f5-claude-chrome-cwd-"));
    const launch = () => {
      const input = createControllableAsyncIterable<SDKUserMessage>();
      const q = query({
        prompt: input.iterable,
        options: {
          cwd,
          pathToClaudeCodeExecutable: executable,
          persistSession: false,
          settingSources: [],
          env: buildClaudeQueryEnv(
            { subagentModel: "inherit" },
            { ...process.env, HOME: userHome },
          ),
          maxTurns: 4,
          extraArgs: { chrome: null },
          canUseTool: async (name, toolInput) =>
            name === "mcp__claude-in-chrome__tabs_context_mcp"
              ? { behavior: "allow", updatedInput: toolInput }
              : {
                  behavior: "deny",
                  message: "Only a read-only tab listing is allowed in certification.",
                },
        },
      });
      return { q, input };
    };
    /** Every non-shadowed manifest registered and pointing at the wrapper. */
    const manifestsInPlace = async () => {
      const entries = (await storage.inspect()).filter((entry) => !entry.shadowed);
      return (
        entries.length > 0 &&
        entries.every((entry) => entry.state === "ok" && entry.targetPath === targetPath)
      );
    };
    const awaitConnected = async (q: ReturnType<typeof launch>["q"]) => {
      const deadline = Date.now() + 30_000;
      while (Date.now() < deadline) {
        const status = (await q.mcpServerStatus()).find(
          (entry) => entry.name === record.identity.mcpServerName,
        ) as ChromeServerStatus | undefined;
        if (status?.status === "connected") return status;
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      return undefined;
    };
    const artifactBytes = async () =>
      Promise.all(
        [...before.keys()].map(async (location) => (await readChromeArtifact(location)).bytes),
      );
    const observations: Record<string, unknown> = {};
    let toolNames: string[] = [];
    let firstLaunchBytes: Array<string | null> | undefined;
    // The real browser folders are restored even when a launch step throws.
    try {
      const first = launch();
      try {
        // Measured, not assumed: when the manifests land relative to `connected`.
        const started = Date.now();
        let manifestsAt: number | undefined;
        const watching = (async () => {
          while (manifestsAt === undefined && Date.now() - started < 40_000) {
            if (await manifestsInPlace()) manifestsAt = Date.now();
            else await new Promise((resolve) => setTimeout(resolve, 100));
          }
        })();
        await first.q.initializationResult();
        const status = await awaitConnected(first.q);
        const connectedAt = status ? Date.now() : undefined;
        assertions["status-shape"] = await descriptor.verifyServer!(status, {
          executableRealpath: executable,
          toolNames:
            (status?.tools as Array<{ name: string }> | undefined)?.map((tool) => tool.name) ?? [],
          realpath,
        });
        toolNames = ((status?.tools as Array<{ name: string }> | undefined) ?? [])
          .map((tool) => tool.name)
          .sort();
        assertions["tool-inventory"] = toolNames.length > 0;
        const launched = await transactions.recordLaunch(approved, {
          verifyWrapper: (bytes) => descriptor.verifyWrapper!(bytes, executable, realpath),
          allowedOrigins: descriptor.allowedOrigins,
        });
        await watching;
        observations.manifestsMsAfterStart =
          manifestsAt === undefined ? null : manifestsAt - started;
        observations.connectedMsAfterStart =
          connectedAt === undefined ? null : connectedAt - started;
        assertions["write-ordering"] = manifestsAt !== undefined && connectedAt !== undefined;
        assertions["manifests-and-wrapper"] = launched.launchVerified === true;
        // The origins actually written, not the launch flag.
        const expectedOrigins = JSON.stringify([...descriptor.allowedOrigins].sort());
        const written = (await storage.inspect()).filter(
          (entry) => !entry.shadowed && entry.state === "ok",
        );
        assertions["allowed-origins"] =
          written.length > 0 &&
          written.every(
            (entry) => JSON.stringify([...(entry.allowedOrigins ?? [])].sort()) === expectedOrigins,
          );
        firstLaunchBytes = await artifactBytes();
        first.input.push({
          type: "user",
          parent_tool_use_id: null,
          message: {
            role: "user",
            content: "Call tabs_context_mcp once, then reply DONE. Use no other tool.",
          },
        });
        // Only a successful result of the allowed tab listing counts: a denied or failed
        // call also comes back as a `tool_result`, with `is_error`.
        const tabListingIds = new Set<string>();
        for (;;) {
          const next = await first.q.next();
          if (next.done || next.value.type === "result") break;
          const content = (next.value as { message?: { content?: unknown } }).message?.content;
          if (!Array.isArray(content)) continue;
          for (const block of content as Array<Record<string, unknown>>) {
            if (
              block.type === "tool_use" &&
              block.name === "mcp__claude-in-chrome__tabs_context_mcp"
            )
              tabListingIds.add(String(block.id));
            if (
              block.type === "tool_result" &&
              block.is_error !== true &&
              tabListingIds.has(String(block.tool_use_id))
            )
              assertions["read-only-call"] = true;
          }
        }
      } finally {
        first.q.close();
        first.input.end();
      }
      // A second real launch must write exactly the same bytes.
      const second = launch();
      try {
        await second.q.initializationResult();
        if (await awaitConnected(second.q)) {
          const deadline = Date.now() + 10_000;
          while (!(await manifestsInPlace()) && Date.now() < deadline)
            await new Promise((resolve) => setTimeout(resolve, 250));
          assertions["byte-identical-launches"] =
            firstLaunchBytes !== undefined &&
            JSON.stringify(await artifactBytes()) === JSON.stringify(firstLaunchBytes);
        }
      } finally {
        second.q.close();
        second.input.end();
      }
    } finally {
      const restored = await transactions.restore(
        (await storage.loadTransaction("claude", approved.id))!,
        { stopSessions: async () => {}, validateSlot: async () => true },
      );
      let identical = restored.transaction.state === "restored";
      for (const [location, bytes] of before)
        identical &&= (await readChromeArtifact(location)).bytes === bytes;
      assertions["restore-original-bytes"] = identical;
      if (!identical)
        console.error(
          `Restore incomplete; the journal is in ${stateDir} (transaction ${approved.id}).`,
        );
    }
    // Never set here, and never to be set by hand: permission-mode behaviour, routing
    // isolation, stale native hosts, terminal coexistence and frozen-server stop need
    // their own observed harnesses (fixture markers and mutation counters). Until those
    // exist and pass, the generator refuses this report and the gate stays closed.
    const report: IntegrationEvidenceReport & {
      readonly observations: Record<string, unknown>;
      readonly notAutomated: ReadonlyArray<string>;
    } = {
      integration: "claude-chrome",
      evidenceId: process.env.F5_CLAUDE_CHROME_EVIDENCE_ID ?? "",
      platform: process.platform,
      arch: process.arch,
      versions: { ...record.versions },
      assertions,
      toolNames,
      ...(process.env.F5_CLAUDE_CHROME_ARTIFACT_SHA256
        ? { artifactSha256: process.env.F5_CLAUDE_CHROME_ARTIFACT_SHA256 }
        : {}),
      observations,
      notAutomated: Object.keys(assertions).filter(
        (name) =>
          ![
            "manifests-and-wrapper",
            "allowed-origins",
            "write-ordering",
            "status-shape",
            "tool-inventory",
            "read-only-call",
            "restore-original-bytes",
            "byte-identical-launches",
          ].includes(name),
      ),
    };
    if (process.env.F5_CLAUDE_CHROME_REPORT)
      await writeFile(process.env.F5_CLAUDE_CHROME_REPORT, `${JSON.stringify(report, null, 2)}\n`);
    await rm(cwd, { recursive: true, force: true });
    // An incomplete restore keeps the journal so the original bytes stay recoverable.
    if (assertions["restore-original-bytes"]) await rm(stateDir, { recursive: true, force: true });
    expect(assertions["restore-original-bytes"]).toBe(true);
    expect(assertions["manifests-and-wrapper"]).toBe(true);
  }, 180_000);
});
