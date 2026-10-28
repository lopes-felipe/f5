import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { TurnId, type AgentCapabilityState } from "@t3tools/contracts";
import { readCodeSignature } from "@t3tools/shared/codeSignature";
import { translateMcpForCodex } from "@t3tools/shared/mcpTranslation";
import {
  CODEX_CHROME_DRAIN_TOOL,
  INTEGRATION_REQUIRED_ASSERTIONS,
  PROVIDER_INTEGRATION_RECORDS,
  SUPPORTED_CODEX_CHROME_ADMISSION,
  codexParentIdentifierAllowed,
  integrationTemplateRecord,
  type IntegrationEvidenceReport,
} from "@t3tools/shared/providerIntegrationCertification";

import {
  CODEX_THREAD_CONFIG,
  buildCodexInitializeParams,
  mapCodexRuntimeMode,
} from "../src/codexAppServerManager";
import {
  codexChromeRegistrationsUnchanged,
  inspectCodexChrome,
} from "../src/computer/codexNativeIntegrations";
import { AgentControlPause } from "../src/mcp/agentControlPause";
import { CODEX_TURN_METADATA_KEY, toolInventorySha256 } from "../src/mcp/IntegrationProxyCatalog";
import {
  CODEX_CHROME_SERVER_NAME,
  codexBinarySigned,
  codexChromeMcpServer,
  inspectCodexBinary,
} from "../src/provider/codexChromeIntegration";
import { CodexChromeSession, type CodexChromeBroker } from "../src/provider/codexChromeSession";
import { observeCodexChrome } from "../src/provider/Layers/CodexAdapter";
import { buildCodexAppServerCommand } from "../src/provider/codexLaunchArgs";
import { buildProviderChildProcessEnv } from "../src/providerProcessEnv";
import {
  AppServer,
  alive,
  asRecord,
  delay,
  errorText,
  killTree,
  processRows,
  waitFor,
} from "./fixtures/codexAppServer";
import { nodeReplCandidates, statusTools } from "./fixtures/codexHostedSpike";
import { evidenceSource } from "./fixtures/evidenceSource";
import {
  DEFAULT_QUIET_WINDOW,
  markerTitle,
  startMutationServer,
  stoppedAfter,
} from "../../../scripts/lib/mutation-fixture.ts";

/**
 * Live Codex Chrome certification, outside F5, on a clean commit. Codex starts ChatGPT's
 * `node_repl` from the MCP entry F5 builds, and F5's own `CodexChromeSession` adopts,
 * verifies, drains and stops it; main's part (adopting under the session's Codex and
 * killing the process group) is played by the harness the way main does it. The model's
 * calls come from real Full-access turns. It needs ChatGPT.app with its Chrome extension
 * set up and Chrome running, and never stamps a record: it writes a report for
 * `stamp-integration-record.ts` with the exercised versions (stamped as floors, Codex's
 * included), the observed inventory, its schemas, the admission mode and the commit.
 *
 * - F5_CODEX_NATIVE_LIVE=chrome opts in;
 * - F5_CODEX_CHROME_HOME=<dir>: an isolated Codex home authenticated once with
 *   `CODEX_HOME=<dir> codex login` (vitest drops an inherited CODEX_HOME);
 * - F5_CODEX_CHROME_REPORT=<file> receives the report and F5_CODEX_CHROME_EVIDENCE_ID
 *   names it;
 * - F5_CODEX_BINARY overrides the `codex` F5 resolves from PATH.
 */
const optedIn = process.env.F5_CODEX_NATIVE_LIVE === "chrome";
const SERVER = CODEX_CHROME_SERVER_NAME;
const THREAD = "live-certification";
const GENERATION = "live";
const TURN_TIMEOUT_MS = 240_000;

describe.skipIf(!optedIn)("Codex Chrome live certification", () => {
  it("lets Codex start node_repl under F5's supervision and certifies session admission", async () => {
    if (process.env.F5_AGENT_PROCESS === "1")
      throw new Error("Run the Codex Chrome certification outside F5, not from an F5 agent.");
    if (process.platform !== "darwin") throw new Error("Codex Chrome certification is macOS only.");
    const homeInput = process.env.F5_CODEX_CHROME_HOME;
    if (!homeInput)
      throw new Error("Set F5_CODEX_CHROME_HOME to a Codex home authenticated with codex login.");
    const userHome = userInfo().homedir;
    const codexHome = await realpath(resolve(homeInput));
    if (codexHome === (await realpath(join(userHome, ".codex")).catch(() => undefined)))
      throw new Error("F5_CODEX_CHROME_HOME must be an isolated Codex home, not ~/.codex.");
    // Only the static identity is used; versions and inventory come from this run. The
    // stamper defaults to the same template, so the identity exercised is the one stamped.
    const template = integrationTemplateRecord(
      PROVIDER_INTEGRATION_RECORDS["codex-chrome"],
      process.platform,
      process.arch,
    );
    if (!template) throw new Error(`No Codex Chrome record for darwin-${process.arch}.`);
    // Taken before anything runs; the report file written at the end doesn't count.
    const source = evidenceSource();
    // Certification exercises whatever ChatGPT and Codex are installed: every identity,
    // signature, origin and helper check still applies, and the run's versions become floors.
    const floorless = {
      ...template,
      versions: { appMin: "0", pluginMin: "0", codexMin: "0" },
    };
    const installed = await inspectCodexChrome({ userHome, record: floorless });
    if (!installed.available) throw new Error(installed.reason);
    const codex = await inspectCodexBinary({
      binaryPath: process.env.F5_CODEX_BINARY ?? "codex",
      processEnvironment: process.env,
      cwd: process.cwd(),
    });
    if (!codex.path || !codex.version) throw new Error("Couldn't resolve Codex or its version.");
    if (!(await codexBinarySigned(codex.path, template.identity.teamId)))
      throw new Error(`${codex.path} isn't an OpenAI-signed Codex.`);

    const assertions: Record<string, boolean> = Object.fromEntries(
      INTEGRATION_REQUIRED_ASSERTIONS["codex-chrome"].map((name) => [name, false]),
    );
    const observations: Record<string, unknown> = {};
    const run = randomBytes(4).toString("hex");
    const markers = {
      title: `cert-title-${run}`,
      after: `cert-after-interrupt-${run}`,
      fetch: `cert-bg-fetch-${run}`,
      pause: `cert-pause-${run}`,
      off: `cert-off-${run}`,
    };
    const fixture = await startMutationServer();
    const workdir = await mkdtemp(join(tmpdir(), "f5-codex-chrome-live-"));
    const url = (marker: string) => JSON.stringify(`${fixture.origin}/marker/${marker}`);
    const client = JSON.stringify(join(installed.pluginRoot, "scripts", "browser-client.mjs"));
    const connect = `const { setupBrowserRuntime } = await import(${client});
const agent = await setupBrowserRuntime();
const chrome = await agent.browsers.get("chrome");`;
    const readTitle = (marker: string) => `${connect}
const tab = await chrome.tabs.new();
await tab.goto(${url(marker)});
nodeRepl.write(await tab.title());
await tab.close();`;
    // Work F5 must stop: a Node timer left running after its call, and a tab loop in a
    // call still in flight (a loop left running after its call can't drive Chrome).
    const fetchTimer = `setInterval(() => {
  fetch(${url(markers.fetch)} + "?n=" + Date.now()).catch(() => {});
}, 100);
nodeRepl.write("started");`;
    const tabLoop = (marker: string) => `${connect}
const tab = await chrome.tabs.new();
for (let i = 0; i < 400; i++) {
  await tab.goto(${url(marker)} + "?n=" + i);
  await new Promise((resolve) => setTimeout(resolve, 250));
}
nodeRepl.write("finished");`;

    // Main's part. Adoption: exactly one `node_repl` child of the session's Codex, running
    // the verified executable, in its own process group, under an OpenAI-signed parent.
    const supervised = new Map<string, { pid: number; pgid: number }>();
    const adoptions: Array<Record<string, unknown>> = [];
    const kills: Array<Promise<void>> = [];
    let lastAdopted: { pid: number; pgid: number } | undefined;
    const disabled = new Set<(threadId: string, generation: string) => void>();
    const pause = new AgentControlPause();
    const broker: CodexChromeBroker = {
      host: {
        profileId: "live-certification",
        correlated: async () => ({ ok: true }),
        send: () => undefined,
      } as never,
      pause,
      generation: () => GENERATION,
      chromeRecoveryRequired: () => false,
      adoptIntegrationProcess: async (adoption) => {
        const rows = processRows();
        const children = nodeReplCandidates(rows, adoption.parentPid, adoption.executable).filter(
          (row) => row.ppid === adoption.parentPid,
        );
        const parent = rows.find((row) => row.pid === adoption.parentPid);
        const signature = parent
          ? await readCodeSignature(parent.command, { teamId: template.identity.teamId })
          : undefined;
        const candidate = children.length === 1 ? children[0]! : undefined;
        const verified =
          candidate !== undefined &&
          candidate.pgid === candidate.pid &&
          signature?.ok === true &&
          codexParentIdentifierAllowed(signature.identifier);
        adoptions.push({
          candidates: children.length,
          parentExecutable: parent?.command,
          parentIdentifier: signature?.ok ? signature.identifier : undefined,
          ownProcessGroup: candidate ? candidate.pgid === candidate.pid : undefined,
          verified,
        });
        if (!verified) {
          for (const row of children) if (alive(row.pid)) process.kill(row.pid, "SIGKILL");
          throw new Error("Couldn't verify the node_repl Codex started.");
        }
        supervised.set(adoption.launchToken, { pid: candidate.pid, pgid: candidate.pgid });
        lastAdopted = { pid: candidate.pid, pgid: candidate.pgid };
        return {} as never;
      },
      // Group kill: SIGTERM now, SIGKILL after 1 s.
      stopIntegrationProcess: (launchToken) => {
        const target = supervised.get(launchToken);
        supervised.delete(launchToken);
        if (!target) return;
        const signal = (name: NodeJS.Signals) => {
          try {
            process.kill(-target.pgid, name);
          } catch {}
        };
        signal("SIGTERM");
        kills.push(
          delay(1000).then(() => {
            if (alive(target.pid)) signal("SIGKILL");
          }),
        );
      },
      onChromeDisabled: (listener) => {
        disabled.add(listener);
        return () => disabled.delete(listener);
      },
    };

    const answer = (method: string) => {
      // Full access asks nothing for node_repl; anything else is refused.
      if (method === "mcpServer/elicitation/request") return { action: "decline" };
      throw new Error(`The certification doesn't answer ${method}.`);
    };
    // The runtime's own MCP entry, translated the way session start translates it.
    const entry = translateMcpForCodex({
      [SERVER]: codexChromeMcpServer(
        { eligible: true, installation: installed, codexHome },
        process.env,
      ),
    })?.[SERVER];
    if (!entry) throw new Error("No node_repl MCP entry.");
    const environment = buildProviderChildProcessEnv(process.env, { CODEX_HOME: codexHome });
    const command = buildCodexAppServerCommand({
      environment,
      mcpServers: { [SERVER]: entry },
      disablePlugins: true,
    });
    const child = spawn(codex.path, [...command.argv], {
      cwd: workdir,
      env: environment,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const server = new AppServer(child, answer);
    const appServerPid = child.pid!;
    const states: Array<[AgentCapabilityState, string | undefined]> = [];
    const drains: Array<{ turnId: unknown; ok: boolean; result: string }> = [];
    let reloads = 0;
    const policy = { enabled: true };
    let session: CodexChromeSession | undefined;
    let threadId: string | undefined;
    const settle = async () => {
      await Promise.all(kills.splice(0));
      await delay(250);
    };

    const callJs = async (code: string, turnId: string, timeoutMs = 60_000) => {
      try {
        return JSON.stringify(
          (await server.request(
            "mcpServer/tool/call",
            {
              threadId,
              server: SERVER,
              tool: "js",
              arguments: { code, timeout_ms: timeoutMs },
              _meta: { [CODEX_TURN_METADATA_KEY]: { session_id: threadId, turn_id: turnId } },
            },
            timeoutMs + 30_000,
          )) ?? null,
        );
      } catch (error) {
        return `error: ${errorText(error)}`;
      }
    };
    /** One real turn: the model calls `js` with `code`, exactly as given. */
    const startTurn = async (code: string) => {
      await session!.beforeTurn();
      const since = Date.now();
      const prompt = [
        "This is an automated integration test. Use only the `js` tool of the `node_repl` MCP server",
        "(it may appear as `mcp__node_repl__js`; if it isn't visible, search for `node_repl js`).",
        "Make exactly one call, passing `code` exactly as given and nothing else:",
        `code = ${JSON.stringify(code)}`,
        "Call no other tool and don't change the code. Then reply with the single word DONE.",
      ].join("\n");
      const turn = asRecord(
        asRecord(
          await server.request("turn/start", {
            threadId,
            input: [{ type: "text", text: prompt, text_elements: [] }],
          }),
        )?.turn,
      );
      if (typeof turn?.id !== "string") throw new Error("turn/start returned no turn id.");
      return { turnId: turn.id, since };
    };
    /** Waits until each marker's work is observably running, then stops it with `stop`. */
    const stopsWork = async (work: ReadonlyArray<string>, stop: () => void) => {
      const runningBy = Date.now() + 20_000;
      while (
        work.some((marker) => fixture.hits(marker).length < DEFAULT_QUIET_WINDOW.minHitsBefore) &&
        Date.now() < runningBy
      )
        await delay(100);
      const target = lastAdopted;
      const stoppedAt = Date.now();
      stop();
      await settle();
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
        work.map((marker) => {
          const hits = fixture.hits(marker);
          return [
            marker,
            {
              hitsBefore: hits.filter((time) => time <= stoppedAt).length,
              hitsAfter: hits.filter((time) => time > stoppedAt).length,
              stopped: stoppedAfter(hits, stoppedAt, observedUntil),
            },
          ];
        }),
      );
      const gone = target !== undefined && !alive(target.pid);
      return {
        passed: gone && Object.values(perMarker).every((entry) => entry.stopped),
        gone,
        markers: perMarker,
      };
    };

    let failure: unknown;
    let tools: ReturnType<typeof statusTools> = [];
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
      if (typeof thread?.id !== "string") throw new Error("thread/start returned no thread id.");
      threadId = thread.id;
      const startup = await waitFor(() => {
        const status = server.startupStatus(SERVER, startedAt);
        return status === "ready" || status === "failed" ? status : undefined;
      }, 30_000);
      if (startup !== "ready") throw new Error(`node_repl startup: ${startup ?? "timed out"}.`);

      // The record carries no inventory until this run supplies it: observe it through
      // Codex, then hold the session to it, as a certified record would.
      const listRow = async () => {
        const listing = asRecord(await server.request("mcpServerStatus/list", {}));
        return (Array.isArray(listing?.data) ? listing.data : []).find(
          (row) => asRecord(row)?.name === SERVER,
        );
      };
      tools = statusTools(await listRow());
      const sha256 = toolInventorySha256(tools);
      const expectedNames = [...template.identity.allowedTools, CODEX_CHROME_DRAIN_TOOL].sort();
      const installation = { ...installed, record: { ...floorless, toolInventorySha256: sha256 } };
      observations.inventoryChangedFromRecord =
        template.toolInventorySha256 !== undefined && template.toolInventorySha256 !== sha256;

      session = new CodexChromeSession({
        threadId: THREAD,
        generation: GENERATION,
        installation,
        userHome,
        broker,
        codex: {
          pid: () => appServerPid,
          providerThreadId: () => threadId,
          listServer: listRow,
          reload: async () => {
            reloads += 1;
            await server.request("config/mcpServer/reload", undefined);
          },
          callTool: async (tool, args, meta) => {
            const result = asRecord(
              await server.request("mcpServer/tool/call", {
                threadId,
                server: SERVER,
                tool,
                arguments: args,
                _meta: meta,
              }),
            );
            if (tool === CODEX_CHROME_DRAIN_TOOL)
              drains.push({
                turnId: args.turn_id,
                ok: result !== undefined && result.isError !== true,
                result: JSON.stringify(result ?? null).slice(0, 500),
              });
            return result;
          },
        },
        policyEnabled: async () => policy.enabled,
        stateChanged: (state, detail) => states.push([state, detail]),
        // Idle stop is an acceptance check on the desktop app, not part of this run.
        setTimeout: () => undefined,
        clearTimeout: () => undefined,
      });
      const live = session;
      // Read fresh each time: the phase changes underneath awaits.
      const phase = (): string => live.state;
      server.listeners.add((method, params) => {
        const turnId = asRecord(asRecord(params)?.turn)?.id ?? asRecord(params)?.turnId;
        observeCodexChrome(live, {
          method,
          payload: params,
          ...(typeof turnId === "string" ? { turnId: TurnId.makeUnsafe(turnId) } : {}),
        } as never);
      });
      // Codex reported this runtime before the session existed.
      live.startupStatus("ready");
      await live.beforeTurn();
      const firstAdoption = adoptions[0];
      assertions["codex-parent-verified"] =
        firstAdoption?.verified === true && live.state === "ready";
      assertions["tool-inventory"] =
        JSON.stringify(tools.map((tool) => tool.name).sort()) === JSON.stringify(expectedNames) &&
        tools.every((tool) => asRecord(tool.inputSchema) !== undefined) &&
        live.state === "ready";
      observations.adoption = firstAdoption;
      if (live.state !== "ready")
        throw new Error(`Session didn't start: ${JSON.stringify(states)}`);

      // A real turn: the model opens a tab and reads its title.
      const titleTurn = await startTurn(readTitle(markers.title));
      const titleDone = await waitFor(
        () => server.turnCompleted(titleTurn.turnId, titleTurn.since),
        TURN_TIMEOUT_MS,
      );
      const titleCalls = server.toolCalls(SERVER, titleTurn.since);
      assertions["open-tab-read-title"] =
        titleDone !== undefined &&
        fixture.hits(markers.title).length > 0 &&
        titleCalls.some((item) =>
          JSON.stringify(item?.result ?? null).includes(markerTitle(markers.title)),
        );
      observations.titleTurn = {
        status: asRecord(asRecord(titleDone?.params)?.turn)?.status,
        calls: titleCalls.map((item) => ({
          tool: item?.tool,
          status: item?.status,
          result: JSON.stringify(item?.result ?? item?.error ?? null).slice(0, 1000),
        })),
      };

      // Interrupt a real turn mid-call: F5 interrupts the turn, then drains it through
      // node_repl's own hook; a fresh tab claim afterwards proves nothing stayed stuck.
      const hungTurn = await startTurn(
        "await new Promise((resolve) => setTimeout(resolve, 120000));\nnodeRepl.write('woke');",
      );
      const hungStarted = await waitFor(
        () =>
          server.notifications.find((entry) => {
            const item = asRecord(asRecord(entry.params)?.item);
            return (
              entry.at >= hungTurn.since &&
              entry.method === "item/started" &&
              item?.type === "mcpToolCall" &&
              item.server === SERVER
            );
          }),
        TURN_TIMEOUT_MS,
      );
      const interruptedAt = Date.now();
      await server.request("turn/interrupt", { threadId, turnId: hungTurn.turnId });
      // As CodexAdapter.interruptTurn does.
      live.turnEnded(hungTurn.turnId);
      const hungDone = await waitFor(
        () => server.turnCompleted(hungTurn.turnId, hungTurn.since),
        15_000,
      );
      await waitFor(() => drains.find((drain) => drain.turnId === hungTurn.turnId), 10_000);
      const drained = drains.find((drain) => drain.turnId === hungTurn.turnId);
      const after = await callJs(readTitle(markers.after), `f5-cert-after-${run}`);
      assertions["interrupt-drains"] =
        hungStarted !== undefined &&
        hungDone !== undefined &&
        asRecord(asRecord(hungDone.params)?.turn)?.status === "interrupted" &&
        drained?.ok === true &&
        after.includes(markerTitle(markers.after));
      observations.interrupt = {
        callStarted: hungStarted !== undefined,
        completedAfterMs: hungDone ? hungDone.at - interruptedAt : undefined,
        status: asRecord(asRecord(hungDone?.params)?.turn)?.status,
        drain: drained,
        after: after.slice(0, 500),
      };

      // Pause (and ⌃⌘Esc, which pauses) stops the runtime through main.
      const workTurn = `f5-cert-work-${run}`;
      await callJs(fetchTimer, workTurn);
      const pausedLoop = callJs(tabLoop(markers.pause), workTurn, 120_000);
      const paused = await stopsWork([markers.fetch, markers.pause], () => pause.set(THREAD, true));
      assertions["background-work-stops-on-pause"] = paused.passed && phase() === "stopped";
      observations.pause = { ...paused, inFlight: (await pausedLoop).slice(0, 500) };

      // The next turn after resuming reloads Codex's MCP config and adopts the new runtime.
      pause.set(THREAD, false);
      const before = lastAdopted?.pid;
      await live.beforeTurn();
      observations.restart = {
        reloads,
        state: phase(),
        newProcess: lastAdopted !== undefined && lastAdopted.pid !== before,
      };
      if (phase() !== "ready") throw new Error(`Restart failed: ${JSON.stringify(states)}`);

      // Turning the integration off kills the runtime; the next turn doesn't restart it.
      const offLoop = callJs(tabLoop(markers.off), `f5-cert-off-${run}`, 120_000);
      const off = await stopsWork([markers.off], () => {
        policy.enabled = false;
        for (const listener of disabled) listener(THREAD, GENERATION);
      });
      const reloadsBefore = reloads;
      await live.beforeTurn();
      assertions["policy-off-kills"] =
        off.passed &&
        phase() === "stopped" &&
        states.at(-1)?.[0] === "off" &&
        reloads === reloadsBefore &&
        nodeReplCandidates(processRows(), appServerPid, installed.nodeRepl).length === 0;
      observations.policyOff = {
        ...off,
        inFlight: (await offLoop).slice(0, 500),
        restartedAfterOff: reloads !== reloadsBefore,
      };

      assertions["registrations-unchanged"] = await codexChromeRegistrationsUnchanged(
        installed,
        userHome,
      );
    } catch (error) {
      failure = error;
      observations.error = errorText(error);
    } finally {
      session?.dispose();
      await settle();
      observations.states = states;
      observations.adoptions = adoptions;
      if (child.exitCode === null && child.signalCode === null) await killTree(appServerPid);
      await fixture.close();
      await rm(workdir, { recursive: true, force: true });
    }

    const report: IntegrationEvidenceReport & { readonly observations: Record<string, unknown> } = {
      integration: "codex-chrome",
      evidenceId: process.env.F5_CODEX_CHROME_EVIDENCE_ID ?? "uncommitted",
      platform: process.platform,
      arch: process.arch,
      // The exercised versions, stamped as the record's floors.
      versions: {
        appMin: installed.appVersion,
        pluginMin: installed.pluginVersion,
        codexMin: codex.version,
      },
      assertions,
      admission: SUPPORTED_CODEX_CHROME_ADMISSION,
      toolNames: tools.map((tool) => tool.name),
      ...(tools.length > 0 ? { toolInventorySha256: toolInventorySha256(tools) } : {}),
      toolSchemas: tools.map(({ name, description, inputSchema }) => ({
        name,
        ...(description !== undefined ? { description } : {}),
        inputSchema,
      })),
      ...source,
      observations,
    };
    if (process.env.F5_CODEX_CHROME_REPORT)
      await writeFile(process.env.F5_CODEX_CHROME_REPORT, `${JSON.stringify(report, null, 2)}\n`);
    if (failure) {
      console.error(server.stderrTail);
      throw failure;
    }
    expect(Object.entries(assertions).filter(([, passed]) => !passed)).toEqual([]);
  }, 900_000);
});
