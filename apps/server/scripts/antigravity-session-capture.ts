/**
 * R0 live capture for Antigravity, run by the user from `acp-capability-probe.ts`:
 *
 *   --antigravity-session  shape capture: initialize, auth methods, modes, config options,
 *                          commands, capability flags, `agy acp --help`, per-model thinking
 *                          levels and client-identity comparison. Sends no prompt.
 *   --scripted             behaviour capture (spends quota) in a throwaway git repository.
 *
 * Uses the production profile and runtime path of the given instance. Only the allowlisted
 * projection from `AntigravityCapture.ts` is printed; raw frames never leave this process.
 */
import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { AntigravityAuthMethod } from "@t3tools/contracts";
import { prepareAntigravityProfile } from "../src/provider/acp/AntigravityAcpSupport";
import {
  projectAntigravityCapture,
  type AntigravityCaptureRaw,
  type AntigravityPermissionSample,
} from "../src/provider/acp/AntigravityCapture";
import {
  antigravityLaunchEnvironment,
  type AntigravityAuthConfig,
} from "../src/provider/antigravityAuthSupport";

type Json = Record<string, unknown>;
const record = (value: unknown): Json | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Json)
    : undefined;

class AgentConnection {
  readonly notifications: Json[] = [];
  readonly permissions: AntigravityPermissionSample[] = [];
  sessionMode = "unknown";
  step = "setup";
  private nextId = 1;
  private buffer = "";
  private readonly pending = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: Error) => void }
  >();
  private readonly exited: Promise<void>;
  private constructor(private readonly child: ChildProcessWithoutNullStreams) {
    child.stdout.on("data", (chunk: Buffer) => this.onData(chunk.toString("utf8")));
    child.stderr.resume();
    this.exited = new Promise((resolve) => {
      child.on("exit", () => {
        for (const { reject } of this.pending.values()) reject(new Error("agent-exited"));
        this.pending.clear();
        resolve();
      });
      child.on("error", () => resolve());
    });
  }
  static start(command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv) {
    return new AgentConnection(spawn(command, args, { cwd, env, stdio: ["pipe", "pipe", "pipe"] }));
  }
  private onData(text: string) {
    this.buffer += text;
    let newline: number;
    while ((newline = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      let frame: Json | undefined;
      try {
        frame = record(JSON.parse(line));
      } catch {
        continue;
      }
      if (!frame) continue;
      if (typeof frame.id === "number" && !frame.method) {
        const waiter = this.pending.get(frame.id);
        this.pending.delete(frame.id);
        if (frame.error) waiter?.reject(new Error(String(record(frame.error)?.code ?? "error")));
        else waiter?.resolve(frame.result);
      } else if (frame.method && frame.id !== undefined) {
        this.answer(frame);
      } else if (frame.method === "session/update") {
        this.notifications.push({ ...record(frame.params), at: Date.now() });
      }
    }
  }
  /** Permissions are recorded and answered with the single-use allow; forms are cancelled. */
  private answer(frame: Json) {
    let result: unknown = {};
    if (frame.method === "session/request_permission") {
      const params = record(frame.params);
      this.permissions.push({ step: this.step, sessionMode: this.sessionMode, request: params });
      const options = Array.isArray(params?.options) ? params.options.map(record) : [];
      const allow = options.find((option) => option?.kind === "allow_once");
      result = allow
        ? { outcome: { outcome: "selected", optionId: allow.optionId } }
        : { outcome: { outcome: "cancelled" } };
    } else if (frame.method === "session/elicitation" || frame.method === "elicitation/create") {
      result = { action: { action: "cancel" } };
    }
    this.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: frame.id, result }) + "\n");
  }
  request(method: string, params: unknown, timeoutMs = 120_000): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("timeout"));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      this.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  }
  notify(method: string, params: unknown) {
    this.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
  }
  close() {
    this.child.stdin.end();
    this.child.kill("SIGTERM");
  }
  /** Asks the agent to exit and waits for it, killing it if it outlives `timeoutMs`. */
  async shutdown(timeoutMs = 5_000) {
    if (this.child.exitCode !== null || this.child.signalCode !== null) return;
    this.close();
    const timedOut = await Promise.race([
      this.exited.then(() => false),
      sleep(timeoutMs).then(() => true),
    ]);
    if (timedOut) {
      this.child.kill("SIGKILL");
      await Promise.race([this.exited, sleep(1_000)]);
    }
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const modelOption = (configOptions: unknown) =>
  (Array.isArray(configOptions) ? configOptions : [])
    .map(record)
    .find((option) => option?.category === "model" || option?.id === "model");
const modeOption = (configOptions: unknown) =>
  (Array.isArray(configOptions) ? configOptions : [])
    .map(record)
    .find((option) => option?.category === "mode" || option?.id === "mode");
const optionValues = (option: Json | undefined) =>
  (Array.isArray(option?.options) ? option.options : []).flatMap((entry) => {
    const fields = record(entry);
    if (Array.isArray(fields?.options))
      return fields.options.flatMap((nested) => {
        const value = record(nested)?.value;
        return typeof value === "string" ? [value] : [];
      });
    return typeof fields?.value === "string" ? [fields.value] : [];
  });

export async function captureAntigravitySession(input: {
  stateDir: string;
  instanceId: string;
  authMethod: AntigravityAuthMethod;
  accountTier: string;
  scripted: boolean;
}) {
  const auth: AntigravityAuthConfig = {
    authMethod: input.authMethod,
    apiKey:
      input.authMethod === "gemini-api-key" ? (process.env.F5_PROBE_GEMINI_API_KEY ?? "") : "",
  };
  const prepared = await prepareAntigravityProfile({
    stateDir: input.stateDir,
    instanceId: input.instanceId,
    environment: process.env,
    auth,
    // The capture authenticates itself, like Connect, so it skips the verified-key check.
    accountSetup: true,
  });
  const runtimeTemp = await mkdtemp(path.join(tmpdir(), "f5-agy-capture-tmp-"));
  const workspace = await mkdtemp(path.join(tmpdir(), "f5-agy-capture-repo-"));
  const env = {
    ...antigravityLaunchEnvironment({
      base: process.env,
      home: prepared.home,
      harness: prepared.executable.harnessPath,
      browserCommand: prepared.browser,
      auth,
    }),
    TMPDIR: runtimeTemp,
    TMP: runtimeTemp,
    TEMP: runtimeTemp,
  };
  const args = ["acp", "--gemini-dir", prepared.home, "--app-data-dir", "antigravity-acp"];
  const raw: {
    -readonly [K in keyof AntigravityCaptureRaw]: AntigravityCaptureRaw[K];
  } = {};
  const helpText = await promisify(execFile)(
    prepared.executable.executablePath,
    ["acp", "--help"],
    {
      env,
      timeout: 15_000,
      maxBuffer: 256 * 1024,
    },
  ).then(
    (output) => output.stdout + output.stderr,
    () => "",
  );
  raw.helpText = helpText;
  // Every agent started here, shut down before the directories it uses are removed.
  const agents = new Set<AgentConnection>();
  const connect = async (clientName = "f5") => {
    const agent = AgentConnection.start(prepared.executable.executablePath, args, workspace, env);
    agents.add(agent);
    try {
      const initialize = await agent.request("initialize", {
        protocolVersion: 1,
        clientCapabilities: {
          elicitation: { form: {} },
          fs: { readTextFile: false, writeTextFile: false },
          terminal: false,
        },
        clientInfo: { name: clientName, version: "1" },
      });
      await agent.request("authenticate", { methodId: auth.authMethod });
      return { agent, initialize };
    } catch (error) {
      await agent.shutdown();
      throw error;
    }
  };
  try {
    await promisify(execFile)("git", ["init", "-q"], { cwd: workspace });
    const { agent, initialize } = await connect();
    raw.initialize = initialize;
    const session = record(await agent.request("session/new", { cwd: workspace, mcpServers: [] }));
    const sessionId = String(session?.sessionId ?? "");
    await sleep(2_000);
    raw.session = {
      modes: session?.modes,
      configOptions: session?.configOptions,
      commands: agent.notifications.flatMap((notification) => {
        const update = record(notification.update);
        return update?.sessionUpdate === "available_commands_update" &&
          Array.isArray(update.availableCommands)
          ? update.availableCommands
          : [];
      }),
    };
    const model = modelOption(session?.configOptions);
    const original = typeof model?.currentValue === "string" ? model.currentValue : undefined;
    const modelId = typeof model?.id === "string" ? model.id : "model";
    const models: Array<{ id: string; configOptions: unknown }> = [];
    let lastCycled: string | undefined;
    for (const value of optionValues(model).slice(0, 24)) {
      const response = record(
        await agent
          .request("session/set_config_option", { sessionId, configId: modelId, value })
          .catch(() => undefined),
      );
      if (response) {
        models.push({ id: value, configOptions: response.configOptions });
        lastCycled = value;
      }
    }
    raw.models = models;
    // Does cycling change the account default? Read it from a fresh session before restoring.
    const probeSession = record(
      await agent.request("session/new", { cwd: workspace, mcpServers: [] }).catch(() => undefined),
    );
    const freshDefault = modelOption(probeSession?.configOptions)?.currentValue;
    if (original)
      await agent
        .request("session/set_config_option", { sessionId, configId: modelId, value: original })
        .catch(() => undefined);
    // Restoration must hold for a new process, not only this connection.
    const fresh = await connect().catch(() => undefined);
    const restoredDefault = fresh
      ? modelOption(
          record(
            await fresh.agent
              .request("session/new", { cwd: workspace, mcpServers: [] })
              .catch(() => undefined),
          )?.configOptions,
        )?.currentValue
      : undefined;
    fresh?.agent.close();
    const identity = await connect("zed").catch(() => undefined);
    const otherCatalog = identity
      ? optionValues(
          modelOption(
            record(
              await identity.agent
                .request("session/new", { cwd: workspace, mcpServers: [] })
                .catch(() => undefined),
            )?.configOptions,
          ),
        )
      : undefined;
    identity?.agent.close();
    raw.checks = {
      defaultModelPersistsAfterCycling:
        typeof freshDefault === "string" && lastCycled !== undefined && lastCycled !== original
          ? freshDefault === lastCycled
          : null,
      catalogIdenticalUnderF5: otherCatalog
        ? JSON.stringify(otherCatalog.toSorted()) === JSON.stringify(optionValues(model).toSorted())
        : null,
      defaultRestoredInFreshProcess:
        original && typeof restoredDefault === "string" ? restoredDefault === original : null,
      apiKeyVisibleToShell: null,
      apiKeyVisibleToMcpChildren: null,
      // Hook and plugin execution has no generic probe; it is recorded by hand (null = unknown).
      executedProjectHooks: null,
      rejectedModes: [],
    };
    if (input.scripted) await runScripted(agent, sessionId, raw, session, auth, connect, workspace);
    agent.close();
  } finally {
    await Promise.all([...agents].map((agent) => agent.shutdown()));
    await rm(workspace, { recursive: true, force: true });
    await rm(runtimeTemp, { recursive: true, force: true });
  }
  return projectAntigravityCapture(raw, {
    agyVersion: prepared.executable.version ?? "unknown",
    platform: `${process.platform}-${process.arch}`,
    authMethod: auth.authMethod,
    accountTier: input.accountTier,
    capturedOn: new Date().toISOString().slice(0, 10),
  });
}

async function runScripted(
  agent: AgentConnection,
  sessionId: string,
  raw: { -readonly [K in keyof AntigravityCaptureRaw]: AntigravityCaptureRaw[K] },
  session: Json | undefined,
  auth: AntigravityAuthConfig,
  connect: (name?: string) => Promise<{ agent: AgentConnection; initialize: unknown }>,
  workspace: string,
) {
  // Modes may be advertised as session modes, as a mode config option, or both.
  const sessionModes = (
    Array.isArray(record(session?.modes)?.availableModes)
      ? (record(session?.modes)!.availableModes as unknown[])
      : []
  ).flatMap((mode) => (typeof record(mode)?.id === "string" ? [String(record(mode)!.id)] : []));
  const modeConfig = modeOption(session?.configOptions);
  const configModes = optionValues(modeConfig);
  const modes = [...new Set([...sessionModes, ...configModes])];
  const promptResponses: unknown[] = [];
  const prompt = async (text: string, timeoutMs = 300_000) => {
    const response = await agent.request(
      "session/prompt",
      { sessionId, prompt: [{ type: "text", text }] },
      timeoutMs,
    );
    promptResponses.push(response);
    return response;
  };
  // Permissions are labelled only with a mode the CLI confirmed; a rejected write is recorded
  // and that mode's step is skipped.
  const rejectedModes: string[] = [];
  // A mode the config option lists is written there, as F5 does; otherwise via set_mode.
  const setMode = async (mode: string) => {
    const viaConfig = typeof modeConfig?.id === "string" && configModes.includes(mode);
    const accepted = await (
      viaConfig
        ? agent.request("session/set_config_option", {
            sessionId,
            configId: modeConfig.id,
            value: mode,
          })
        : agent.request("session/set_mode", { sessionId, modeId: mode })
    )
      .then(() => true)
      .catch(() => false);
    if (accepted) agent.sessionMode = mode;
    else rejectedModes.push(mode);
    return accepted;
  };
  const editAndCommand =
    "Create a file named f5-probe.txt containing the word ok, then run the shell command `ls`. Reply DONE.";
  for (const mode of ["default", "auto", "plan"]) {
    if (mode !== "default" && !modes.includes(mode)) continue;
    agent.step = `edit-and-command:${mode}`;
    if (!(await setMode(mode))) continue;
    await prompt(editAndCommand).catch(() => undefined);
  }
  await setMode("default");
  raw.checks = { ...raw.checks, rejectedModes };

  agent.step = "steer";
  let firstSettled = false;
  const first = prompt("Count slowly from 1 to 30, one number per line.")
    .catch((error: Error) => error)
    .finally(() => {
      firstSettled = true;
    });
  await sleep(1_500);
  // A first prompt that already finished leaves nothing to steer: the result proves nothing.
  const inconclusive = firstSettled;
  const second = await prompt("Stop counting and reply STEERED.").catch((error: Error) => error);
  const firstResult = await first;
  raw.steer = {
    secondPromptAccepted: !(second instanceof Error),
    stopReasons: [firstResult, second].map((value) =>
      value instanceof Error ? value.message : value,
    ),
    inconclusive,
  };

  agent.step = "background";
  const before = agent.notifications.length;
  await prompt(
    "Start the shell command `sleep 8 && echo done` in the background, then reply STARTED immediately without waiting.",
  ).catch(() => undefined);
  const afterResponse = agent.notifications.length;
  await sleep(15_000);
  raw.backgroundWake = {
    updatesAfterPromptResponse: agent.notifications.slice(Math.max(before, afterResponse)),
  };

  agent.step = "stop-resend";
  const stopped = prompt("Write a 2000-word essay about tides.").catch((error: Error) => error);
  await sleep(1_000);
  agent.notify("session/cancel", { sessionId });
  const firstStopReason = await stopped;
  const secondStopReason = await prompt("Reply OK.").catch((error: Error) => error.message);
  raw.stopResend = { firstStopReason, secondStopReason };

  if (auth.authMethod === "gemini-api-key") {
    agent.step = "key-visibility";
    const start = agent.notifications.length;
    await prompt(
      "Run the shell command `printenv GEMINI_API_KEY | wc -c` and reply only with the number it prints.",
    ).catch(() => undefined);
    const reply = agent.notifications
      .slice(start)
      .map((notification) => record(record(notification.update)?.content)?.text)
      .filter((text): text is string => typeof text === "string")
      .join("");
    const count = Number.parseInt(reply.match(/\d+/)?.[0] ?? "", 10);
    raw.checks = { ...raw.checks, apiKeyVisibleToShell: Number.isFinite(count) ? count > 1 : null };

    // A stdio MCP child records whether the key reached its environment, never the value.
    agent.step = "key-visibility-mcp";
    const marker = path.join(workspace, ".f5-mcp-key-marker");
    const probe = path.join(workspace, ".f5-mcp-probe.cjs");
    await writeFile(
      probe,
      `require("fs").writeFileSync(${JSON.stringify(marker)}, process.env.GEMINI_API_KEY ? "1" : "0");`,
    );
    await agent
      .request("session/new", {
        cwd: workspace,
        mcpServers: [{ name: "f5-probe", command: process.execPath, args: [probe], env: [] }],
      })
      .catch(() => undefined);
    await sleep(5_000);
    const seen = await readFile(marker, "utf8").catch(() => undefined);
    raw.checks = {
      ...raw.checks,
      apiKeyVisibleToMcpChildren: seen === undefined ? null : seen === "1",
    };
  }

  raw.usageFrames = agent.notifications.flatMap((notification) => {
    const update = record(notification.update);
    return update?.sessionUpdate === "usage_update" ? [update] : [];
  });
  raw.promptResponses = promptResponses;
  raw.permissions = agent.permissions;

  // Cold resume in a new process.
  agent.step = "resume";
  const model = modelOption(session?.configOptions);
  agent.close();
  const resumed = await connect().catch(() => undefined);
  if (resumed) {
    const response = await resumed.agent
      .request("session/resume", { sessionId, cwd: workspace, mcpServers: [] })
      .then(
        (value) => ({ ok: true, response: value }),
        () => ({ ok: false }),
      );
    raw.resume = {
      ...response,
      ...(typeof model?.currentValue === "string" ? { modelBefore: model.currentValue } : {}),
    };
    resumed.agent.close();
  } else raw.resume = { ok: false };
}
