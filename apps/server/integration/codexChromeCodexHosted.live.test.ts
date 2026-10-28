import { execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { CodexMcpServerEntry } from "@t3tools/contracts";
import { readCodeSignature } from "@t3tools/shared/codeSignature";
import {
  PROVIDER_INTEGRATION_RECORDS,
  compareVersions,
  integrationTemplateRecord,
} from "@t3tools/shared/providerIntegrationCertification";

import {
  CODEX_THREAD_CONFIG,
  buildCodexInitializeParams,
  mapCodexRuntimeMode,
} from "../src/codexAppServerManager";
import { mcpElicitationResponse } from "../src/codex/mcpElicitation";
import {
  codexChromeChildEnvironment,
  inspectCodexChrome,
} from "../src/computer/codexNativeIntegrations";
import {
  CODEX_TURN_METADATA_KEY,
  INTEGRATION_TOOL_TIMEOUT_SEC,
  toolInventorySha256,
} from "../src/mcp/IntegrationProxyCatalog";
import { buildCodexAppServerCommand } from "../src/provider/codexLaunchArgs";
import { buildProviderChildProcessEnv } from "../src/providerProcessEnv";
import {
  CODEX_HOSTED_MIN_VERSION,
  CODEX_HOSTED_OBSERVATIONS,
  OPENAI_TEAM_ID,
  codexHostedBranches,
  codexParentIdentifierAllowed,
  nodeReplCandidates,
  nodeReplToolApproval,
  spikeDescendants,
  statusTools,
  type CodexHostedObservation,
} from "./fixtures/codexHostedSpike";
import {
  AppServer,
  asRecord,
  delay,
  errorText,
  killTree,
  processRows,
  waitFor,
} from "./fixtures/codexAppServer";
import { evidenceSource } from "./fixtures/evidenceSource";
import {
  DEFAULT_QUIET_WINDOW,
  markerTitle,
  startMutationServer,
  stoppedAfter,
} from "../../../scripts/lib/mutation-fixture.ts";

/**
 * Spike D: Codex itself starts ChatGPT's `node_repl` as a stdio MCP server, because
 * ChatGPT's Chrome host drops a `node_repl` whose parent isn't a signed Codex binary.
 * One real Full-access turn calls `js` twice; the harness approves the first call and
 * declines the second, then kills, reloads and drains `node_repl` the way F5 would. It
 * writes a spike file with the observations and the Phase 1 branches they select, and
 * never writes evidence or stamps a record.
 *
 * Run from Terminal outside F5, with ChatGPT.app, its Chrome extension and Chrome:
 * - F5_CODEX_NATIVE_LIVE=codex-hosted opts in;
 * - F5_CODEX_HOSTED_HOME=<dir>: an isolated Codex home authenticated once with
 *   `CODEX_HOME=<dir> codex login` (vitest drops an inherited CODEX_HOME);
 * - F5_CODEX_HOSTED_SPIKE=<file> receives the spike file (keep it outside the checkout);
 * - F5_CODEX_BINARY overrides the `codex` F5 resolves from PATH.
 */
const optedIn = process.env.F5_CODEX_NATIVE_LIVE === "codex-hosted";
const SERVER = "node_repl";
const TURN_TIMEOUT_MS = 240_000;

function appServerDescendants(rows: ReturnType<typeof processRows>, root: number) {
  return spikeDescendants(rows, root).map(({ pid, ppid, pgid, command }) => ({
    pid,
    ppid,
    pgid,
    command,
  }));
}

describe.skipIf(!optedIn)("Codex-hosted node_repl spike (Spike D)", () => {
  it("lets Codex start node_repl and records approval, supervision, reload and drain", async () => {
    if (process.env.F5_AGENT_PROCESS === "1")
      throw new Error("Run Spike D outside F5, not from an F5 agent.");
    if (process.platform !== "darwin") throw new Error("Spike D is macOS only.");
    const spikePath = process.env.F5_CODEX_HOSTED_SPIKE;
    if (!spikePath) throw new Error("Set F5_CODEX_HOSTED_SPIKE to the spike file to write.");
    const codexHomeInput = process.env.F5_CODEX_HOSTED_HOME;
    if (!codexHomeInput)
      throw new Error("Set F5_CODEX_HOSTED_HOME to a Codex home authenticated with codex login.");
    const userHome = userInfo().homedir;
    const codexHome = await realpath(resolve(codexHomeInput));
    if (codexHome === (await realpath(join(userHome, ".codex")).catch(() => undefined)))
      throw new Error("F5_CODEX_HOSTED_HOME must be an isolated Codex home, not ~/.codex.");
    // Taken before anything runs; keep the spike file outside the checkout.
    const source = evidenceSource();
    const record = integrationTemplateRecord(
      PROVIDER_INTEGRATION_RECORDS["codex-chrome"],
      process.platform,
      process.arch,
    );
    if (!record) throw new Error(`No Codex Chrome record for darwin-${process.arch}.`);
    // The spike exercises whatever ChatGPT is installed; every identity check still applies.
    const installation = await inspectCodexChrome({
      userHome,
      record: { ...record, versions: { appMin: "0", pluginMin: "0" } },
    });
    if (!installation.available) throw new Error(installation.reason);

    const binary = process.env.F5_CODEX_BINARY ?? "codex";
    const codexVersion = /\d+\.\d+\.\d+/.exec(
      execFileSync(binary, ["--version"], { encoding: "utf8" }),
    )?.[0];
    if (!codexVersion || (compareVersions(codexVersion, CODEX_HOSTED_MIN_VERSION) ?? -1) < 0)
      throw new Error(
        `${binary} is Codex ${codexVersion ?? "unknown"}; Spike D needs ${CODEX_HOSTED_MIN_VERSION} or newer (set F5_CODEX_BINARY).`,
      );

    const observed = Object.fromEntries(
      CODEX_HOSTED_OBSERVATIONS.map((name) => [name, false]),
    ) as Record<CodexHostedObservation, boolean>;
    const details: Record<string, unknown> = {};
    const run = randomBytes(4).toString("hex");
    const markers = {
      title: `hosted-title-${run}`,
      backgroundFetch: `hosted-bg-fetch-${run}`,
      backgroundTab: `hosted-bg-tab-${run}`,
      inFlight: `hosted-in-flight-${run}`,
      approved: `hosted-approved-${run}`,
      declined: `hosted-declined-${run}`,
      reload: `hosted-reload-${run}`,
    };
    const fixture = await startMutationServer();
    const workdir = await mkdtemp(join(tmpdir(), "f5-codex-hosted-"));
    const url = (marker: string) => JSON.stringify(`${fixture.origin}/marker/${marker}`);
    const client = JSON.stringify(join(installation.pluginRoot, "scripts", "browser-client.mjs"));
    // The browser probe runs step by step, so a hang names the step that hung. Top-level
    // bindings persist between calls in the same kernel.
    const probeSteps = [
      {
        name: "connect",
        expect: "connected",
        code: `const { setupBrowserRuntime } = await import(${client});
const agent = await setupBrowserRuntime();
const chrome = await agent.browsers.get("chrome");
nodeRepl.write("connected");`,
      },
      {
        name: "new-tab",
        expect: "tab",
        code: `const tab = await chrome.tabs.new();
nodeRepl.write("tab");`,
      },
      {
        name: "goto",
        expect: "loaded",
        code: `await tab.goto(${url(markers.title)});
nodeRepl.write("loaded");`,
      },
      {
        name: "title",
        expect: markerTitle(markers.title),
        code: "nodeRepl.write(await tab.title());",
      },
    ] as const;
    // Work F5 must stop, three ways: a Node timer and a sequential tab loop left running
    // after their call returned, and a tab loop inside a call still in flight. The tab
    // loop records why a navigation failed (for example, refused outside a call).
    const backgroundStart = (withTab: boolean) => `const bgErrors = [];
let bgTabLoads = 0;
setInterval(() => {
  fetch(${url(markers.backgroundFetch)} + "?n=" + Date.now()).catch(() => {});
}, 100);
${
  withTab
    ? `(async () => {
  for (let i = 0; i < 600; i++) {
    try {
      await tab.goto(${url(markers.backgroundTab)} + "?n=" + i);
      bgTabLoads++;
    } catch (error) {
      if (bgErrors.length < 5) bgErrors.push(String(error?.message ?? error));
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
})();`
    : ""
}
nodeRepl.write("started");`;
    const backgroundStatus = "nodeRepl.write(JSON.stringify({ bgTabLoads, bgErrors }));";
    const inFlightCall = `for (let i = 0; i < 200; i++) {
  await tab.goto(${url(markers.inFlight)} + "?n=" + i);
  await new Promise((resolve) => setTimeout(resolve, 250));
}
nodeRepl.write("finished");`;
    // The turn's calls don't need Chrome: approval is about whether a call runs at all.
    // Each is self-contained, so it reaches the fixture if and only if it ran.
    const approvedCall = `const approved = await fetch(${url(markers.approved)});
nodeRepl.write(String(approved.status));`;
    const declinedCall = `const declined = await fetch(${url(markers.declined)});
nodeRepl.write(String(declined.status));`;
    const reloadCall = `const { setupBrowserRuntime } = await import(${client});
const agent = await setupBrowserRuntime();
const chrome = await agent.browsers.get("chrome");
const tab = await chrome.tabs.new();
await tab.goto(${url(markers.reload)});
nodeRepl.write(await tab.title());
await tab.close();`;

    // Approvals: the turn's first js call is accepted once and every later one declined.
    // The harness's own calls never prompt (Codex only asks for model calls).
    const approvals: Array<{ tool?: string; decision: string; at: number }> = [];
    const answer = (method: string, params: unknown) => {
      const approval = nodeReplToolApproval(method, params, SERVER);
      if (approval) {
        const accept = approval.tool === "js" && approvals.length === 0;
        approvals.push({
          ...(approval.tool ? { tool: approval.tool } : {}),
          decision: accept ? "accept" : "decline",
          at: Date.now(),
        });
        return accept ? mcpElicitationResponse(params, "accept") : { action: "decline" };
      }
      if (method === "mcpServer/elicitation/request") return { action: "decline" };
      throw new Error(`Spike D does not answer ${method}.`);
    };

    // Codex's per-server approval mode is only exercised here, so it stays out of the
    // shared contract; the entry is written to Codex's config as is.
    const entry: CodexMcpServerEntry & {
      readonly default_tools_approval_mode: "prompt";
    } = {
      type: "stdio",
      command: installation.nodeRepl,
      args: [],
      env: Object.fromEntries(
        Object.entries(codexChromeChildEnvironment(installation, codexHome, process.env)).filter(
          (pair): pair is [string, string] => typeof pair[1] === "string",
        ),
      ),
      // Codex refuses `mcpServer/tool/call` for a tool outside `enabled_tools` ("tool
      // 'turn_ended' is disabled"), so the drain hook must be enabled to be observed. F5's
      // admission would decline any model call to it.
      enabled_tools: [...record.identity.allowedTools, "turn_ended"],
      default_tools_approval_mode: "prompt",
      tool_timeout_sec: INTEGRATION_TOOL_TIMEOUT_SEC,
    };
    const environment = buildProviderChildProcessEnv(process.env, { CODEX_HOME: codexHome });
    const command = buildCodexAppServerCommand({
      environment,
      mcpServers: { [SERVER]: entry },
      disablePlugins: true,
    });
    const child = spawn(binary, [...command.argv], {
      cwd: workdir,
      env: environment,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const server = new AppServer(child, answer);
    const appServerPid = child.pid!;
    let failure: unknown;
    try {
      await server.request("initialize", buildCodexInitializeParams());
      server.notify("initialized");
      const startedAt = Date.now();
      const thread = asRecord(
        asRecord(
          await server.request("thread/start", {
            model: null,
            cwd: workdir,
            config: CODEX_THREAD_CONFIG,
            ...mapCodexRuntimeMode("full-access"),
            experimentalRawEvents: false,
          }),
        )?.thread,
      );
      const threadId = thread?.id;
      if (typeof threadId !== "string") throw new Error("thread/start returned no thread id.");
      details.startupStatus = await waitFor(() => {
        const status = server.startupStatus(SERVER, startedAt);
        return status === "ready" || status === "failed" ? status : undefined;
      }, 30_000);

      // Inventory through Codex, not by listing node_repl directly.
      const listing = asRecord(await server.request("mcpServerStatus/list", {}));
      const row = (Array.isArray(listing?.data) ? listing.data : []).find(
        (candidate) => asRecord(candidate)?.name === SERVER,
      );
      const tools = statusTools(row);
      observed["inventory-via-status"] = record.identity.allowedTools.every((name) =>
        tools.some((tool) => tool.name === name && asRecord(tool.inputSchema) !== undefined),
      );
      details.inventory = {
        enabledTools: entry.enabled_tools,
        toolNames: tools.map((tool) => tool.name),
        toolInventorySha256: tools.length > 0 ? toolInventorySha256(tools) : undefined,
        toolSchemas: tools,
      };

      // Adoption as main would do it: exactly one verified node_repl under this app-server.
      const rows = processRows();
      const candidates = nodeReplCandidates(rows, appServerPid, installation.nodeRepl);
      const nodeRepl = candidates.length === 1 ? candidates[0] : undefined;
      const parent = nodeRepl && rows.find((entry) => entry.pid === nodeRepl.ppid);
      const signature =
        parent && (await readCodeSignature(parent.command, { teamId: OPENAI_TEAM_ID }));
      observed["parent-identity"] =
        signature?.ok === true && codexParentIdentifierAllowed(signature.identifier);
      observed["own-process-group"] = nodeRepl !== undefined && nodeRepl.pgid === nodeRepl.pid;
      details.adoption = {
        candidates: candidates.length,
        // When adoption finds nothing: what runs below the app-server, by executable.
        descendants: candidates.length === 1 ? undefined : appServerDescendants(rows, appServerPid),
        parentExecutable: parent?.command,
        parentIsAppServer: parent?.pid === appServerPid,
        parentSignature: signature,
        nodeReplPgidIsPid: observed["own-process-group"],
      };

      // The harness's own calls carry Codex turn metadata, which ChatGPT's browser runtime
      // requires ("Missing required Codex turn metadata"); Codex forwards `_meta`.
      const callJs = async (code: string, turnId: string, timeoutMs = 60_000) => {
        const started = Date.now();
        try {
          const result = await server.request(
            "mcpServer/tool/call",
            {
              threadId,
              server: SERVER,
              tool: "js",
              arguments: { code, timeout_ms: timeoutMs },
              _meta: { [CODEX_TURN_METADATA_KEY]: { session_id: threadId, turn_id: turnId } },
            },
            timeoutMs + 30_000,
          );
          return { text: JSON.stringify(result ?? null), ms: Date.now() - started };
        } catch (error) {
          return { text: `error: ${errorText(error)}`, ms: Date.now() - started };
        }
      };

      // Does ChatGPT's Chrome host serve the Codex-started node_repl?
      const probeTurn = `f5-spike-probe-${run}`;
      const probe: Array<{ step: string; passed: boolean; ms: number; excerpt: string }> = [];
      for (const step of probeSteps) {
        const result = await callJs(step.code, probeTurn);
        const passed = result.text.includes(step.expect);
        probe.push({ step: step.name, passed, ms: result.ms, excerpt: result.text.slice(0, 1500) });
        if (!passed) break;
      }
      observed["codex-parent-accepted"] = probe.at(-1)?.step === "title" && probe.at(-1)!.passed;
      details.browserProbe = {
        steps: probe,
        // A load here with a failed goto means Chrome navigated but the reply never came.
        titlePageLoads: fixture.hits(markers.title).length,
      };

      // One real Full-access turn: approve the first js call, decline the second.
      const prompt = [
        "This is an automated integration test. Use only the `js` tool of the `node_repl` MCP server",
        "(it may appear as `mcp__node_repl__js`; if it isn't visible, search for `node_repl js`).",
        "Make exactly two calls, one after the other, passing `code` exactly as given:",
        `1. code = ${JSON.stringify(approvedCall)}`,
        `2. code = ${JSON.stringify(declinedCall)}`,
        "Make the second call even if the first fails. If a call is declined, don't retry it.",
        "Call no other tool and don't change the code. Then reply with the single word DONE.",
      ].join("\n");
      const turnSince = Date.now();
      const turn = asRecord(
        asRecord(
          await server.request("turn/start", {
            threadId,
            input: [{ type: "text", text: prompt, text_elements: [] }],
          }),
        )?.turn,
      );
      const turnId = turn?.id;
      if (typeof turnId !== "string") throw new Error("turn/start returned no turn id.");
      const completed = await waitFor(
        () =>
          server.notifications.find(
            (entry) =>
              entry.at >= turnSince &&
              entry.method === "turn/completed" &&
              asRecord(asRecord(entry.params)?.turn)?.id === turnId,
          ),
        TURN_TIMEOUT_MS,
      );
      if (!completed) {
        await server.request("turn/interrupt", { threadId, turnId }).catch(() => undefined);
        throw new Error("The spike turn didn't complete in time.");
      }
      const calls = server.notifications
        .filter((entry) => entry.at >= turnSince && entry.method === "item/completed")
        .map((entry) => asRecord(asRecord(entry.params)?.item))
        .filter((item) => item?.type === "mcpToolCall" && item.server === SERVER);
      const jsCalls = calls.filter((item) => item?.tool === "js");
      // An approval for every model call, the accepted one ran and the declined one didn't.
      observed["approval-requested"] =
        jsCalls.length >= 2 &&
        approvals.length >= jsCalls.length &&
        approvals[0]?.decision === "accept" &&
        approvals.some((entry) => entry.decision === "decline") &&
        fixture.hits(markers.approved).length > 0 &&
        fixture.hits(markers.declined).length === 0;
      const finished = asRecord(asRecord(completed.params)?.turn);
      details.turn = {
        status: finished?.status,
        error: JSON.stringify(finished?.error ?? null).slice(0, 2000),
        errors: server.notifications
          .filter((entry) => entry.at >= turnSince && entry.method === "error")
          .map((entry) => JSON.stringify(entry.params ?? null).slice(0, 1000)),
        jsCalls: jsCalls.length,
        calls: calls.map((item) => ({
          tool: item?.tool,
          status: item?.status,
          result: JSON.stringify(item?.result ?? item?.error ?? null).slice(0, 1000),
        })),
        approvals,
        // Without approvals both calls run and both markers are hit.
        approvedCallHits: fixture.hits(markers.approved).length,
        declinedCallHits: fixture.hits(markers.declined).length,
      };

      // Drain through node_repl's own hook while it still runs.
      try {
        const ended = asRecord(
          await server.request("mcpServer/tool/call", {
            threadId,
            server: SERVER,
            tool: "turn_ended",
            arguments: { hook_event_name: "Stop", session_id: threadId, turn_id: turnId },
          }),
        );
        observed["turn-ended-callable"] = ended !== undefined && ended.isError !== true;
        details.turnEnded = { result: JSON.stringify(ended ?? null).slice(0, 2000) };
      } catch (error) {
        details.turnEnded = { error: errorText(error) };
      }

      // Kill the node_repl tree while work it started drives the fixture.
      const withTab = observed["codex-parent-accepted"];
      const started = await callJs(backgroundStart(withTab), probeTurn);
      await delay(3000);
      const status = await callJs(backgroundStatus, probeTurn);
      // Not awaited: the kill lands while this call is still running.
      const inFlight = withTab ? callJs(inFlightCall, probeTurn, 120_000) : undefined;
      const workMarkers = withTab
        ? [markers.backgroundFetch, markers.backgroundTab, markers.inFlight]
        : [markers.backgroundFetch];
      const chromeMarkers = withTab ? [markers.backgroundTab, markers.inFlight] : [];
      const runningBy = Date.now() + 15_000;
      while (
        (fixture.hits(markers.backgroundFetch).length < DEFAULT_QUIET_WINDOW.minHitsBefore ||
          (withTab &&
            fixture.hits(markers.inFlight).length < DEFAULT_QUIET_WINDOW.minHitsBefore)) &&
        Date.now() < runningBy
      )
        await delay(100);
      const current = nodeReplCandidates(processRows(), appServerPid, installation.nodeRepl);
      if (current.length === 1) {
        const stoppedAt = Date.now();
        const killed = await killTree(current[0]!.pid);
        await delay(
          Math.max(
            0,
            stoppedAt +
              DEFAULT_QUIET_WINDOW.settleMs +
              DEFAULT_QUIET_WINDOW.quietMs +
              250 -
              Date.now(),
          ),
        );
        const observedUntil = Date.now();
        const perMarker = Object.fromEntries(
          workMarkers.map((marker) => {
            const hits = fixture.hits(marker);
            return [
              marker,
              {
                hitsBeforeKill: hits.filter((time) => time <= stoppedAt).length,
                hitsAfterKill: hits.filter((time) => time > stoppedAt).length,
                lastHitAfterKillMs: Math.max(0, (hits.at(-1) ?? stoppedAt) - stoppedAt),
                // Positive control: it was running before the kill and is quiet after it.
                stopped: stoppedAfter(hits, stoppedAt, observedUntil),
                quiet: stoppedAfter(hits, stoppedAt, observedUntil, {
                  ...DEFAULT_QUIET_WINDOW,
                  minHitsBefore: 0,
                }),
              },
            ];
          }),
        );
        // Every kind of work is quiet afterwards, and work driving Chrome (or, without
        // Chrome, the Node timer) was observably running before the kill.
        observed["kill-stops-background"] =
          Object.values(perMarker).every((entry) => entry.quiet) &&
          (withTab ? chromeMarkers : [markers.backgroundFetch]).some(
            (marker) => perMarker[marker]!.stopped,
          );
        details.kill = {
          killed: killed.length,
          started: started.text.slice(0, 500),
          // Whether a tab loop left running after its call can drive Chrome at all.
          backgroundStatus: status.text.slice(0, 1500),
          inFlightResult: inFlight ? (await inFlight).text.slice(0, 1000) : undefined,
          markers: perMarker,
          statusAfterKill: server.startupStatus(SERVER, stoppedAt),
        };

        // Reload must start a new node_repl that serves the next call. Through Chrome when
        // the probe reached it; otherwise a plain call shows the respawned kernel works.
        const reloadSince = Date.now();
        const approvalsBeforeReload = approvals.length;
        try {
          await server.request("config/mcpServer/reload", undefined);
          details.reloadStatus = await waitFor(() => {
            const status = server.startupStatus(SERVER, reloadSince);
            return status === "ready" || status === "failed" ? status : undefined;
          }, 20_000);
          const viaChrome = observed["codex-parent-accepted"];
          const result = await callJs(
            viaChrome ? reloadCall : 'nodeRepl.write("respawned");',
            `f5-spike-reload-${run}`,
          );
          const respawned = nodeReplCandidates(processRows(), appServerPid, installation.nodeRepl);
          observed["reload-respawns"] =
            respawned.length === 1 &&
            respawned[0]!.pid !== current[0]!.pid &&
            result.text.includes(viaChrome ? markerTitle(markers.reload) : "respawned");
          details.reload = {
            viaChrome,
            respawnedCandidates: respawned.length,
            newPid: respawned.length === 1 && respawned[0]!.pid !== current[0]!.pid,
            directCallPrompted: approvals.length > approvalsBeforeReload,
            resultExcerpt: result.text.slice(0, 2000),
          };
        } catch (error) {
          details.reload = { error: errorText(error) };
        }
      } else {
        details.kill = { skipped: `found ${current.length} node_repl processes` };
      }
    } catch (error) {
      failure = error;
      details.error = errorText(error);
    } finally {
      details.serverRequests = server.serverRequests.map(({ method, serverName }) => ({
        method,
        ...(typeof serverName === "string" ? { serverName } : {}),
      }));
      if (child.exitCode === null && child.signalCode === null) await killTree(appServerPid);
      await fixture.close();
      await rm(workdir, { recursive: true, force: true });
    }

    const spike = {
      kind: "codex-hosted-spike",
      ...source,
      platform: process.platform,
      arch: process.arch,
      versions: {
        codex: codexVersion,
        app: installation.appVersion,
        plugin: installation.pluginVersion,
      },
      codexBinary: binary,
      observations: observed,
      branches: codexHostedBranches(observed),
      details,
    };
    await writeFile(spikePath, `${JSON.stringify(spike, null, 2)}\n`);
    if (failure) {
      console.error(server.stderrTail);
      throw failure;
    }
    // The spike reports what it saw; a false observation selects a branch, not a failure.
    expect(Object.keys(spike.observations)).toEqual([...CODEX_HOSTED_OBSERVATIONS]);
  }, 600_000);
});
