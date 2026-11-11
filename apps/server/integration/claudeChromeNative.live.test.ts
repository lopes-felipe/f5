import * as NodeServices from "@effect/platform-node/NodeServices";
import { execFile, execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { query, type CanUseTool, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import type { ProfileId } from "@t3tools/contracts";
import {
  INTEGRATION_CAPABILITY_ASSERTIONS,
  INTEGRATION_REQUIRED_ASSERTIONS,
  PROVIDER_INTEGRATION_RECORDS,
  integrationTemplateRecord,
  type IntegrationEvidenceReport,
} from "@t3tools/shared/providerIntegrationCertification";

import { buildAccountExecutionEnvironment } from "../src/providerProcessEnv.ts";
import { buildClaudeQueryEnv } from "../src/provider/Layers/ClaudeAdapter.ts";
import {
  clearProjectionSources,
  projectClaudeRegistrations,
  projectionIo,
} from "../src/provider/chromeRegistrationProjection";
import { isolatedClaudeHome } from "../src/provider/chromeSessionRuntimeFactory";
import { createControllableAsyncIterable } from "../src/provider/Layers/ClaudeSdk.testUtils.ts";
import { claudeChromeDescriptor, type ChromeServerStatus } from "../src/provider/chromeNativeHost";
import { inspectChromeNativeHosts } from "../src/provider/chromeNativeHostInspection";
import { ChromeNativeHostTransactions } from "../src/provider/chromeNativeHostJournal";
import {
  makeChromeNativeHostStorage,
  readChromeArtifact,
} from "../src/provider/chromeNativeHostStorage";
import { resolveBundledClaudeExecutable } from "../src/provider/claudeSdkExecutable";
import {
  bridgeSocketDir,
  callsRouted,
  classifyListing,
  hostSurvivedFlip,
  liveBridgeHosts,
  processAlive,
  sameGroup,
  scrubError,
  sharedTabCount,
} from "./fixtures/claudeChromeShared";
import { evidenceSource } from "./fixtures/evidenceSource";

const execFileAsync = promisify(execFile);

/**
 * Live Claude in Chrome certification run. It writes the real browser native-messaging
 * folders, so it must run on a real Mac outside F5 (an F5 agent sandbox cannot reach
 * them). It never stamps a record: it writes a scrubbed report that
 * `generate-claude-chrome-descriptor.ts --evidence` validates before stamping.
 *
 * F5_CLAUDE_CHROME_LIVE=1 opts in; F5_CLAUDE_CHROME_REPORT=<file> receives the report;
 * F5_CLAUDE_CHROME_CONFIG_DIR=<dir> is the isolated, claude.ai-signed-in Claude config F5's
 * sessions use. Vitest drops an inherited CLAUDE_CONFIG_DIR (see vitest.config.ts), so the
 * harness takes its own variable and passes it to the CLI explicitly.
 * F5_CLAUDE_CHROME_ISOLATED_STATE_DIR=<dir>, optional, is an isolated F5 profile's folder
 * (`~/.f5/userdata-profiles/<id>`) whose Claude is signed in to the same claude.ai account
 * as the extension; it adds the isolated-profile phase.
 * F5_CLAUDE_CHROME_SHARED_CONFIG_DIR=<dir>, optional, is a second isolated Claude config
 * (neither ~/.claude nor F5_CLAUDE_CHROME_CONFIG_DIR) signed in to the same claude.ai
 * account; it adds the shared-host phase, which plays two F5 profiles holding Chrome at
 * once. That phase also opens one blank tab per session in its own tab group and closes it.
 */
const optedIn = process.env.F5_CLAUDE_CHROME_LIVE === "1";
describe.skipIf(!optedIn)("Claude in Chrome live certification", () => {
  it("launches, verifies, and restores the browser setup byte-for-byte", async () => {
    if (process.env.F5_AGENT_PROCESS === "1")
      throw new Error("Run the Claude in Chrome certification outside F5, not from an F5 agent.");
    if (process.platform !== "darwin")
      throw new Error("Claude in Chrome certification is macOS only.");
    // The newest non-withdrawn record: a covered Claude bump runs against the same identity.
    const record = integrationTemplateRecord(
      PROVIDER_INTEGRATION_RECORDS["claude-chrome"],
      process.platform,
      process.arch,
    );
    if (!record) throw new Error(`No Claude in Chrome record for darwin-${process.arch}.`);
    // Taken before anything runs; the report file written at the end doesn't count.
    const source = evidenceSource();
    const descriptor = claudeChromeDescriptor(record);
    const userHome = userInfo().homedir;
    const configDir = process.env.F5_CLAUDE_CHROME_CONFIG_DIR;
    if (!configDir)
      throw new Error(
        "Set F5_CLAUDE_CHROME_CONFIG_DIR to an isolated Claude config signed in to claude.ai (not ~/.claude).",
      );
    const providerHome = await realpath(configDir);
    const executable = await realpath(resolveBundledClaudeExecutable());
    // The exercised build, reported as the floors the generator stamps (never the record's).
    const exercised = {
      sdkMin: (
        JSON.parse(await readFile(join(dirname(executable), "package.json"), "utf8")) as {
          version: string;
        }
      ).version,
      cliMin: execFileSync(executable, ["--version"], { encoding: "utf8" }).trim().split(/\s/)[0]!,
    };
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
    const TAB_CONTEXT = "mcp__claude-in-chrome__tabs_context_mcp";
    const SELECT_BROWSER = "mcp__claude-in-chrome__select_browser";
    /** In every denial message, so a denied call is told apart from a failed one. */
    const DENIAL_MARK = "allowed in certification";
    /**
     * Browsers on this Mac that the CLI offered when several are connected to the account.
     * A session may select only these, so its calls reach the Chrome this run watches.
     */
    const localDevices = new Set<string>();
    const selectsLocalBrowser = (name: string, toolInput: Record<string, unknown>) =>
      name === SELECT_BROWSER && localDevices.has(String(toolInput.deviceId));
    const tabListingOnly: CanUseTool = async (name, toolInput) =>
      name === TAB_CONTEXT || selectsLocalBrowser(name, toolInput)
        ? { behavior: "allow", updatedInput: toolInput }
        : {
            behavior: "deny",
            message: `Only a read-only tab listing is ${DENIAL_MARK}.`,
          };
    const launch = (
      env: NodeJS.ProcessEnv = { ...process.env, HOME: userHome, CLAUDE_CONFIG_DIR: providerHome },
      canUseTool: CanUseTool = tabListingOnly,
    ) => {
      const input = createControllableAsyncIterable<SDKUserMessage>();
      const q = query({
        prompt: input.iterable,
        options: {
          cwd,
          pathToClaudeCodeExecutable: executable,
          persistSession: false,
          settingSources: [],
          env: buildClaudeQueryEnv({ subagentModel: "inherit" }, env),
          maxTurns: 4,
          extraArgs: { chrome: null },
          canUseTool,
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
    /**
     * Runs one turn and returns its tool results, by tool name. A denied or failed call
     * also comes back as a `tool_result`, flagged `isError`.
     */
    const runTurn = async (handle: ReturnType<typeof launch>, prompt: string) => {
      handle.input.push({
        type: "user",
        parent_tool_use_id: null,
        message: { role: "user", content: prompt },
      });
      const names = new Map<string, string>();
      const results: Array<{ name: string; isError: boolean; content: unknown }> = [];
      for (;;) {
        const next = await handle.q.next();
        if (next.done || next.value.type === "result") break;
        const content = (next.value as { message?: { content?: unknown } }).message?.content;
        if (!Array.isArray(content)) continue;
        for (const block of content as Array<Record<string, unknown>>) {
          if (block.type === "tool_use") names.set(String(block.id), String(block.name));
          const name = names.get(String(block.tool_use_id));
          if (block.type === "tool_result" && name)
            results.push({ name, isError: block.is_error === true, content: block.content });
        }
      }
      return results;
    };
    /** How a listing ended, for the report: no tab ids, device ids or page text. */
    type ListingRecord = {
      outcome: string;
      selectedLocalBrowser?: true;
      choice?: { connected: number; local: number };
      error?: string;
      shape?: Record<string, unknown>;
    };
    /**
     * Asks for one tab listing. When several browsers are connected to the account, the CLI
     * answers with a browser choice instead of reaching Chrome; the session then selects
     * the first browser on this Mac and asks again. Only a listing that parses counts.
     */
    const listTabs = async (handle: ReturnType<typeof launch>, createIfEmpty: boolean) => {
      const ask = `Call tabs_context_mcp once${createIfEmpty ? " with createIfEmpty set to true" : ""}, then reply DONE. Use no other tool.`;
      const listing = async (prompt: string) =>
        classifyListing(
          (await runTurn(handle, prompt)).filter((result) => result.name === TAB_CONTEXT),
          DENIAL_MARK,
        );
      let result = await listing(ask);
      let selected = false;
      const deviceId = result.choice?.localDeviceId;
      if (result.outcome === "browser-not-selected" && deviceId) {
        localDevices.add(deviceId);
        selected = true;
        result = await listing(
          `Call select_browser once with deviceId "${deviceId}". Then call tabs_context_mcp once${createIfEmpty ? " with createIfEmpty set to true" : ""}, then reply DONE. Use no other tool.`,
        );
      }
      const record: ListingRecord = {
        outcome: result.outcome,
        ...(selected ? { selectedLocalBrowser: true as const } : {}),
        ...(result.choice
          ? { choice: { connected: result.choice.connected, local: result.choice.local } }
          : {}),
        ...(result.error ? { error: result.error } : {}),
        ...(result.shape ? { shape: result.shape } : {}),
      };
      return { context: result.context, record };
    };
    /** Read-only listings of the base and isolated phases, by label. */
    const readOnlyListings: Record<string, ListingRecord> = {};
    const readOnlyCall = async (handle: ReturnType<typeof launch>, label: string) => {
      const { context, record } = await listTabs(handle, false);
      readOnlyListings[label] = record;
      return context !== undefined;
    };
    const observations: Record<string, unknown> = { readOnlyListings };
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
        assertions["read-only-call"] = await readOnlyCall(first, "base");
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
    // A terminal `claude --chrome` (the user's own ~/.claude) during an F5 session takes the
    // browser connection: F5's launch snapshot no longer matches, which F5 reports as
    // external-cli-conflict, and F5 never writes it back, even on restore. Runs after the
    // first restore, so `restore-original-bytes` above measures the untouched original.
    // Leaves the terminal's registration in place, as running `claude --chrome` would.
    const terminalTarget = descriptor.expectedTarget(join(userHome, ".claude"));
    // True unless a contested session ran and its restore left something behind.
    let contestedRestoreClean = true;
    if (terminalTarget === targetPath) {
      observations.terminal = {
        skipped: "set F5_CLAUDE_CHROME_CONFIG_DIR to a config other than ~/.claude",
      };
    } else if (assertions["restore-original-bytes"]) {
      const contested = await transactions.approve({
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
      let terminalBytes: Array<string | null> | undefined;
      const session = launch();
      try {
        await session.q.initializationResult();
        if (await awaitConnected(session.q)) {
          const launched = await transactions.recordLaunch(contested, {
            verifyWrapper: (bytes) => descriptor.verifyWrapper!(bytes, executable, realpath),
            allowedOrigins: descriptor.allowedOrigins,
          });
          // The user's own terminal Claude: no config dir, so it uses ~/.claude.
          const { CLAUDE_CONFIG_DIR: _isolated, ...terminalEnv } = process.env;
          let exitCode = 0;
          try {
            // Async, so F5's session keeps being served while the terminal runs.
            await execFileAsync(executable, ["--chrome", "-p", "Reply OK.", "--max-turns", "1"], {
              cwd,
              env: { ...terminalEnv, HOME: userHome },
              timeout: 90_000,
            });
          } catch (error) {
            const code = (error as { code?: unknown }).code;
            exitCode = typeof code === "number" ? code : -1;
          }
          const current = (await storage.inspect()).filter((entry) => !entry.shadowed);
          const terminalRegistered =
            current.length > 0 &&
            current.every((entry) => entry.state === "ok" && entry.targetPath === terminalTarget);
          // What F5's per-call admission compares (`registrationUnchanged`).
          const conflict = (launched.launchSnapshot ?? []).some(
            (entry) =>
              !entry.shadowed &&
              current.find((now) => now.location === entry.location)?.sha256 !== entry.sha256,
          );
          terminalBytes = terminalRegistered ? await artifactBytes() : undefined;
          observations.terminal = { exitCode, terminalRegistered, conflict };
          assertions["terminal-claude-unaffected"] =
            exitCode === 0 && terminalRegistered && conflict;
        }
      } finally {
        session.q.close();
        session.input.end();
        const contestedRestore = await transactions.restore(
          (await storage.loadTransaction("claude", contested.id))!,
          { stopSessions: async () => {}, validateSlot: async () => true },
        );
        // Only the manifests the terminal took may be skipped; F5's own wrapper and
        // anything unresolved mean the journal is still needed.
        contestedRestoreClean =
          contestedRestore.unresolved.length === 0 &&
          !contestedRestore.skipped.includes(targetPath);
        observations.contestedRestore = {
          state: contestedRestore.transaction.state,
          skipped: contestedRestore.skipped.length,
          unresolved: contestedRestore.unresolved.length,
        };
        if (!contestedRestoreClean)
          console.error(
            `Contested restore incomplete; the journal is in ${stateDir} (transaction ${contested.id}).`,
          );
      }
      // Restore skips artifacts that changed outside F5: the terminal's registration stays.
      const manifestsAfter = (await artifactBytes()).slice(0, -1);
      const untouched =
        terminalBytes !== undefined &&
        JSON.stringify(manifestsAfter) === JSON.stringify(terminalBytes.slice(0, -1));
      observations.terminal = {
        ...(observations.terminal as object),
        untouchedAfterRestore: untouched,
      };
      assertions["terminal-claude-unaffected"] &&= untouched;
    }
    // Isolated F5 profile: Claude runs with the profile's own HOME, exactly as F5 builds
    // it, and F5 copies the registration the CLI wrote there into the real home. Optional:
    // without it the record gets no `isolated-profiles` capability.
    const isolatedStateDirInput = process.env.F5_CLAUDE_CHROME_ISOLATED_STATE_DIR;
    let isolatedRestoreClean = true;
    if (!isolatedStateDirInput) {
      observations.isolated = {
        skipped: "set F5_CLAUDE_CHROME_ISOLATED_STATE_DIR to an isolated F5 profile's folder",
      };
    } else if (!assertions["restore-original-bytes"] || !contestedRestoreClean) {
      observations.isolated = { skipped: "an earlier restore was incomplete" };
    } else {
      for (const name of INTEGRATION_CAPABILITY_ASSERTIONS["isolated-profiles"])
        assertions[name] = false;
      const isolatedStateDir = await realpath(isolatedStateDirInput);
      const isolatedEnv = buildAccountExecutionEnvironment({
        purpose: "provider",
        profile: {
          id: "0".repeat(32) as ProfileId,
          slug: "certification",
          name: "Certification",
          isDefault: false,
        },
        stateDir: isolatedStateDir,
        baseEnv: process.env,
      });
      const cliHome = isolatedEnv.HOME!;
      const isolatedProviderHome = isolatedEnv.CLAUDE_CONFIG_DIR!;
      if (cliHome !== isolatedClaudeHome(isolatedStateDir))
        throw new Error(`Unexpected isolated HOME ${cliHome}.`);
      const isolatedTarget = descriptor.expectedTarget(isolatedProviderHome);
      const projection = {
        sources: descriptor.locations(isolatedProviderHome, cliHome),
        destinations: descriptor.locations(isolatedProviderHome, userHome),
      };
      const isolatedJournalDir = mkdtempSync(join(tmpdir(), "f5-claude-chrome-isolated-"));
      const isolatedStorage = await Effect.runPromise(
        makeChromeNativeHostStorage({
          stateDir: isolatedJournalDir,
          inspect: () => inspectChromeNativeHosts(projection.destinations),
        }).pipe(Effect.provide(NodeServices.layer)),
      );
      const isolatedTransactions = new ChromeNativeHostTransactions(isolatedStorage);
      const isolatedPaths = [
        ...projection.destinations.map((entry) => (entry.kind === "file" ? entry.path : "")),
        isolatedTarget,
      ];
      const isolatedBefore = new Map<string, string | null>();
      for (const location of isolatedPaths)
        isolatedBefore.set(location, (await readChromeArtifact(location)).bytes);
      const observed = await isolatedStorage.inspect();
      const isolatedApproved = await isolatedTransactions.approve({
        provider: "claude",
        profileId: "live-certification-isolated",
        providerInstanceId: "claudeAgent",
        recordId: record.id,
        providerHome: isolatedProviderHome,
        userHome,
        targetPath: isolatedTarget,
        wrapperLocation: isolatedTarget,
        observed,
        // As consent records it: whatever registration was there before (the terminal's).
        acceptedForeign: observed
          .filter(
            (entry) =>
              !entry.shadowed && entry.state === "ok" && entry.targetPath !== isolatedTarget,
          )
          .map((entry) => ({ location: entry.location, sha256: entry.sha256! })),
      });
      // As F5's prepare does: only manifests this launch writes can be copied, so an
      // earlier run's leftovers never stand in for the CLI's behaviour.
      await clearProjectionSources(projection);
      const isolatedSession = launch(isolatedEnv);
      try {
        await isolatedSession.q.initializationResult();
        if (await awaitConnected(isolatedSession.q)) {
          await projectClaudeRegistrations({
            projection,
            targetPath: isolatedTarget,
            allowedOrigins: descriptor.allowedOrigins,
            verifyWrapper: (bytes) => descriptor.verifyWrapper!(bytes, executable, realpath),
            timeoutMs: 15_000,
            commit: (writes) =>
              isolatedTransactions.commitProjection(isolatedApproved, writes, {
                live: () => true,
                write: (location, bytes) => projectionIo.writeAtomic(location, bytes),
              }),
          });
          const launched = await isolatedTransactions.recordLaunch(isolatedApproved, {
            verifyWrapper: (bytes) => descriptor.verifyWrapper!(bytes, executable, realpath),
            allowedOrigins: descriptor.allowedOrigins,
          });
          // Every destination holds exactly what the CLI wrote under the isolated HOME.
          const copies = await Promise.all(
            projection.sources.map(async (source, index) => {
              const destination = projection.destinations[index]!;
              if (source.kind !== "file" || destination.kind !== "file") return false;
              const from = (await readChromeArtifact(source.path)).bytes;
              return from !== null && from === (await readChromeArtifact(destination.path)).bytes;
            }),
          );
          observations.isolated = {
            copied: copies.filter(Boolean).length,
            of: copies.length,
            launchVerified: launched.launchVerified === true,
          };
          assertions["isolated-projection"] =
            launched.launchVerified === true && copies.length > 0 && copies.every(Boolean);
          assertions["isolated-read-only-call"] = await readOnlyCall(isolatedSession, "isolated");
        }
      } catch (error) {
        observations.isolated = { error: String(error) };
      } finally {
        isolatedSession.q.close();
        isolatedSession.input.end();
        const restored = await isolatedTransactions.restore(
          (await isolatedStorage.loadTransaction("claude", isolatedApproved.id))!,
          { stopSessions: async () => {}, validateSlot: async () => true },
        );
        let identical = restored.transaction.state === "restored";
        for (const [location, bytes] of isolatedBefore)
          identical &&= (await readChromeArtifact(location)).bytes === bytes;
        assertions["isolated-restore"] = identical;
        isolatedRestoreClean = identical;
        if (identical) await rm(isolatedJournalDir, { recursive: true, force: true });
        else
          console.error(
            `Isolated restore incomplete; the journal is in ${isolatedJournalDir} (transaction ${isolatedApproved.id}).`,
          );
      }
    }
    // Two F5 profiles holding Chrome at once: the first profile's session is connected
    // through the running native host when the second profile's CLI rewrites the manifests
    // to its own wrapper. Each profile keeps its own journal, as F5 does. Optional: without
    // it the record gets no `shared-native-host` capability and Chrome stays exclusive.
    const sharedConfigInput = process.env.F5_CLAUDE_CHROME_SHARED_CONFIG_DIR;
    let sharedRestoreClean = true;
    if (!sharedConfigInput) {
      observations.shared = {
        skipped: "set F5_CLAUDE_CHROME_SHARED_CONFIG_DIR to a second isolated Claude config",
      };
    } else if (
      !assertions["restore-original-bytes"] ||
      !contestedRestoreClean ||
      !isolatedRestoreClean
    ) {
      observations.shared = { skipped: "an earlier restore was incomplete" };
    } else {
      for (const name of INTEGRATION_CAPABILITY_ASSERTIONS["shared-native-host"])
        assertions[name] = false;
      const secondHome = await realpath(sharedConfigInput);
      const secondTarget = descriptor.expectedTarget(secondHome);
      if (secondTarget === targetPath || secondTarget === terminalTarget)
        throw new Error(
          "F5_CLAUDE_CHROME_SHARED_CONFIG_DIR must differ from F5_CLAUDE_CHROME_CONFIG_DIR and ~/.claude.",
        );
      const secondLocations = descriptor.locations(secondHome, userHome);
      const secondJournalDir = mkdtempSync(join(tmpdir(), "f5-claude-chrome-shared-"));
      const secondStorage = await Effect.runPromise(
        makeChromeNativeHostStorage({
          stateDir: secondJournalDir,
          inspect: () => inspectChromeNativeHosts(secondLocations),
        }).pipe(Effect.provide(NodeServices.layer)),
      );
      const secondTransactions = new ChromeNativeHostTransactions(secondStorage);
      const sharedBefore = new Map<string, string | null>();
      for (const location of [...before.keys(), secondTarget])
        sharedBefore.set(location, (await readChromeArtifact(location)).bytes);
      /** As consent records it: every registration in place that isn't this profile's. */
      const foreignOf = (
        observed: Awaited<ReturnType<typeof storage.inspect>>,
        ownTarget: string,
      ) =>
        observed
          .filter(
            (entry) => !entry.shadowed && entry.state === "ok" && entry.targetPath !== ownTarget,
          )
          .map((entry) => ({ location: entry.location, sha256: entry.sha256! }));
      const approveFor = async (
        journal: ChromeNativeHostTransactions,
        store: typeof storage,
        input: { profileId: string; providerHome: string; target: string },
      ) => {
        const observed = await store.inspect();
        return journal.approve({
          provider: "claude",
          profileId: input.profileId,
          providerInstanceId: "claudeAgent",
          recordId: record.id,
          providerHome: input.providerHome,
          userHome,
          targetPath: input.target,
          wrapperLocation: input.target,
          observed,
          acceptedForeign: foreignOf(observed, input.target),
        });
      };
      const verifyLaunch = {
        verifyWrapper: (bytes: string) => descriptor.verifyWrapper!(bytes, executable, realpath),
        allowedOrigins: descriptor.allowedOrigins,
      };
      /** Tab listings, selecting this Mac's browser, and closing this session's own tabs. */
      const ownTabsOnly =
        (own: Set<number>): CanUseTool =>
        async (name, toolInput) =>
          name === TAB_CONTEXT ||
          selectsLocalBrowser(name, toolInput) ||
          (name === "mcp__claude-in-chrome__tabs_close_mcp" && own.has(Number(toolInput.tabId)))
            ? { behavior: "allow", updatedInput: toolInput }
            : {
                behavior: "deny",
                message: `Only a tab listing and closing this session's own tabs are ${DENIAL_MARK}.`,
              };
      /** Each listing's outcome, in order, so a failed assertion says which call and why. */
      const listings: Record<string, ListingRecord> = {};
      const listOwnTabs = async (
        label: string,
        handle: ReturnType<typeof launch>,
        own: Set<number>,
      ) => {
        const { context, record } = await listTabs(handle, true);
        listings[label] = record;
        for (const tabId of context?.tabIds ?? []) own.add(tabId);
        return context;
      };
      // Best effort: the CLI also closes a session's blank tab group when it exits.
      const closeOwnTabs = async (handle: ReturnType<typeof launch>, own: Set<number>) => {
        if (own.size === 0) return;
        await runTurn(
          handle,
          `Close each of these tabs with tabs_close_mcp: ${[...own].join(", ")}. Then reply DONE. Use no other tool.`,
        );
      };
      const connectedNow = async (handle: ReturnType<typeof launch>) =>
        (await handle.q.mcpServerStatus()).find(
          (entry) => entry.name === record.identity.mcpServerName,
        )?.status === "connected";
      const manifestsPointAt = async (target: string) => {
        const entries = (await secondStorage.inspect()).filter((entry) => !entry.shadowed);
        return (
          entries.length > 0 &&
          entries.every((entry) => entry.state === "ok" && entry.targetPath === target)
        );
      };
      const bridge = bridgeSocketDir(userInfo().username);
      const firstTabs = new Set<number>();
      const secondTabs = new Set<number>();
      const firstApproved = await approveFor(transactions, storage, {
        profileId: "live-certification",
        providerHome,
        target: targetPath,
      });
      let secondApproved: Awaited<ReturnType<typeof approveFor>> | undefined;
      let first: ReturnType<typeof launch> | undefined;
      let second: ReturnType<typeof launch> | undefined;
      const end = (handle: ReturnType<typeof launch> | undefined) => {
        handle?.q.close();
        handle?.input.end();
      };
      try {
        first = launch(
          { ...process.env, HOME: userHome, CLAUDE_CONFIG_DIR: providerHome },
          ownTabsOnly(firstTabs),
        );
        await first.q.initializationResult();
        if (!(await awaitConnected(first.q)))
          throw new Error("The first profile's session did not connect.");
        const firstLaunch = await transactions.recordLaunch(firstApproved, verifyLaunch);
        const firstBeforeFlip = await listOwnTabs("firstBeforeFlip", first, firstTabs);
        const hostsBefore = await liveBridgeHosts(bridge, processAlive);

        secondApproved = await approveFor(secondTransactions, secondStorage, {
          profileId: "live-certification-shared",
          providerHome: secondHome,
          target: secondTarget,
        });
        second = launch(
          { ...process.env, HOME: userHome, CLAUDE_CONFIG_DIR: secondHome },
          ownTabsOnly(secondTabs),
        );
        await second.q.initializationResult();
        if (!(await awaitConnected(second.q)))
          throw new Error("The second profile's session did not connect.");
        const secondLaunch = await secondTransactions.recordLaunch(secondApproved, verifyLaunch);
        const flipDeadline = Date.now() + 10_000;
        let manifestsFlipped = await manifestsPointAt(secondTarget);
        while (!manifestsFlipped && Date.now() < flipDeadline) {
          await new Promise((resolve) => setTimeout(resolve, 250));
          manifestsFlipped = await manifestsPointAt(secondTarget);
        }
        const firstStillConnected = await connectedNow(first);
        const hostsAfter = await liveBridgeHosts(bridge, processAlive);
        assertions["shared-host-survives-flip"] =
          secondLaunch.launchVerified === true &&
          hostSurvivedFlip({ hostsBefore, hostsAfter, manifestsFlipped, firstStillConnected });

        // Both sessions call at the same time, each through the host the first one reached.
        const [firstContext, secondContext] = await Promise.all([
          listOwnTabs("firstConcurrent", first, firstTabs),
          listOwnTabs("secondConcurrent", second, secondTabs),
        ]);
        assertions["shared-calls-routed"] = callsRouted({
          firstBeforeFlip,
          first: firstContext,
          second: secondContext,
        });
        // What F5's per-call admission compares today: the flip reads as a conflict for
        // the first profile until a shared registration ledger accepts it.
        const current = (await storage.inspect()).filter((entry) => !entry.shadowed);
        const firstSeesConflict = (firstLaunch.launchSnapshot ?? []).some(
          (entry) =>
            !entry.shadowed &&
            current.find((now) => now.location === entry.location)?.sha256 !== entry.sha256,
        );

        // The first profile (the one holding the original bytes) leaves first.
        await closeOwnTabs(first, firstTabs);
        end(first);
        first = undefined;
        const afterExit = await listOwnTabs("secondAfterPeerExit", second, secondTabs);
        const hostsAfterExit = await liveBridgeHosts(bridge, processAlive);
        assertions["shared-peer-exit"] =
          sameGroup(secondContext, afterExit) &&
          JSON.stringify(hostsAfterExit) === JSON.stringify(hostsAfter);
        await closeOwnTabs(second, secondTabs);
        // Outcomes, counts and booleans only: pids and tab ids stay out of the report.
        observations.shared = {
          hostsBefore: hostsBefore.length,
          sameHostsAfterFlip: JSON.stringify(hostsBefore) === JSON.stringify(hostsAfter),
          sameHostsAfterExit: JSON.stringify(hostsAfterExit) === JSON.stringify(hostsAfter),
          manifestsFlipped,
          firstStillConnected,
          secondLaunchVerified: secondLaunch.launchVerified === true,
          listings,
          firstGroupStable: sameGroup(firstBeforeFlip, firstContext),
          sameGroupId:
            firstContext?.tabGroupId !== undefined &&
            firstContext.tabGroupId === secondContext?.tabGroupId,
          sharedTabs: sharedTabCount(firstContext, secondContext),
          secondGroupStableAfterPeerExit: sameGroup(secondContext, afterExit),
          firstSeesConflict,
        };
      } catch (error) {
        observations.shared = {
          ...(observations.shared as object),
          listings,
          error: scrubError(String(error)),
        };
      } finally {
        end(first);
        end(second);
        // Newest first: the second journal puts the first profile's registration back,
        // then the first journal puts back the original bytes.
        let identical = true;
        if (secondApproved) {
          const restored = await secondTransactions.restore(
            (await secondStorage.loadTransaction("claude", secondApproved.id))!,
            { stopSessions: async () => {}, validateSlot: async () => true },
          );
          identical &&= restored.transaction.state === "restored";
        }
        const restored = await transactions.restore(
          (await storage.loadTransaction("claude", firstApproved.id))!,
          { stopSessions: async () => {}, validateSlot: async () => true },
        );
        identical &&= restored.transaction.state === "restored";
        for (const [location, bytes] of sharedBefore)
          identical &&= (await readChromeArtifact(location)).bytes === bytes;
        assertions["shared-restore"] = identical;
        sharedRestoreClean = identical;
        if (identical) await rm(secondJournalDir, { recursive: true, force: true });
        else
          console.error(
            `Shared restore incomplete; the journals are in ${stateDir} (transaction ${firstApproved.id}) and ${secondJournalDir}.`,
          );
      }
    }
    // Every required assertion is observed above; none may be set by hand.
    const report: IntegrationEvidenceReport & {
      readonly observations: Record<string, unknown>;
      readonly notAutomated: ReadonlyArray<string>;
    } = {
      integration: "claude-chrome",
      evidenceId: process.env.F5_CLAUDE_CHROME_EVIDENCE_ID ?? "",
      platform: process.platform,
      arch: process.arch,
      versions: exercised,
      assertions,
      toolNames,
      ...source,
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
            "terminal-claude-unaffected",
            ...INTEGRATION_CAPABILITY_ASSERTIONS["isolated-profiles"],
            ...INTEGRATION_CAPABILITY_ASSERTIONS["shared-native-host"],
          ].includes(name),
      ),
    };
    if (process.env.F5_CLAUDE_CHROME_REPORT)
      await writeFile(process.env.F5_CLAUDE_CHROME_REPORT, `${JSON.stringify(report, null, 2)}\n`);
    await rm(cwd, { recursive: true, force: true });
    // An incomplete restore keeps the journal so the original bytes stay recoverable.
    if (assertions["restore-original-bytes"] && contestedRestoreClean && sharedRestoreClean)
      await rm(stateDir, { recursive: true, force: true });
    expect(assertions["restore-original-bytes"]).toBe(true);
    expect(assertions["manifests-and-wrapper"]).toBe(true);
    expect(isolatedRestoreClean).toBe(true);
    expect(sharedRestoreClean).toBe(true);
    // Two launches, the read-only call, a contested session with a terminal run (up to 30 s
    // to connect plus 90 s for the terminal), the isolated session and the two shared
    // sessions (up to 30 s each to connect, five turns), with room for a slow Mac.
  }, 900_000);
});
