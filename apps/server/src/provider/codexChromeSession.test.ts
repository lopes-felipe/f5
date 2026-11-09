import { describe, expect, it, vi } from "vitest";
import { PROVIDER_INTEGRATION_RECORDS } from "@t3tools/shared/providerIntegrationCertification";
import { AgentControlPause } from "../mcp/agentControlPause";
import type { CodexHandoff } from "../computer/CodexControlHandoff";
import { toolInventorySha256 } from "../mcp/IntegrationProxyCatalog";
import {
  CODEX_CHROME_IDLE_MS,
  CODEX_CHROME_INVENTORY_CHANGED,
  CODEX_CHROME_START_TIMED_OUT,
  CODEX_CHROME_STOPPED_IDLE,
  CODEX_CHROME_STOPPED_INTERRUPTED,
  CODEX_CHROME_STOPPED_OFF,
  CODEX_CHROME_STOPPED_PAUSED,
  CODEX_CHROME_STOPPED_RELEASED,
  CodexChromeSession,
  listedTools,
  type CodexChromeSessionDeps,
} from "./codexChromeSession";

const schema = (name: string) => ({ type: "object", properties: { [name]: { type: "string" } } });
const tools = {
  js: { name: "js", inputSchema: schema("code") },
  js_reset: { name: "js_reset", inputSchema: schema("reset") },
  turn_ended: { name: "turn_ended", inputSchema: schema("turn_id") },
};
const record = {
  ...PROVIDER_INTEGRATION_RECORDS["codex-chrome"][0]!,
  toolInventorySha256: toolInventorySha256(Object.values(tools)),
};
const installation = {
  available: true,
  record,
  appVersion: "26.1016.62342",
  pluginVersion: "26.1016.62342",
  nodeRepl: "/plugin/bin/node_repl",
  hostTarget: "/host",
  hostFingerprint: "fingerprint",
} as unknown as CodexChromeSessionDeps["installation"];

const flush = async () => {
  for (let index = 0; index < 10; index += 1) await Promise.resolve();
};

function harness(overrides: Partial<CodexChromeSessionDeps> = {}) {
  const pause = new AgentControlPause();
  const disabled = new Set<(threadId: string, generation: string) => void>();
  let generation = "gen-1";
  let timer: (() => void) | undefined;
  const releasers = new Map<
    string,
    { idle: () => boolean; release: () => boolean | Promise<boolean> }
  >();
  const host = {
    profileId: "profile",
    correlated: vi.fn(async (..._args: unknown[]) => ({ type: "chromeLeaseResult", ok: true })),
    send: vi.fn(),
  };
  const broker = {
    registerCodexHandoff: vi.fn(
      (_threadId: string, _generation: string, _handoff: CodexHandoff) => () => undefined,
    ),
    waitForChromeRelease: vi.fn(async (): Promise<void> => undefined),
    prepareCodexBrowser: vi.fn(async () => undefined),
    host,
    // The broker's preemption is tested on its own; here it is main's plain acquire.
    acquireChromeLease: vi.fn(async (holder: unknown, timeoutMs?: number) => {
      await host.correlated(
        { type: "chromeLeaseAcquire", requestId: "r", holder },
        timeoutMs,
        false,
      );
    }),
    registerChromeReleaser: (
      threadId: string,
      gen: string,
      releaser: { idle: () => boolean; release: () => boolean | Promise<boolean> },
    ) => {
      releasers.set(`${threadId}\u0000${gen}`, releaser);
      return () => releasers.delete(`${threadId}\u0000${gen}`);
    },
    pause,
    generation: vi.fn(() => generation),
    chromeRecoveryRequired: vi.fn(() => false),
    // Main answers with what it registered: here, always the request's own token.
    adoptIntegrationProcess: vi.fn(
      async (adoption: { launchToken: string }): Promise<{ launchToken: string }> => ({
        launchToken: adoption.launchToken,
      }),
    ),
    stopIntegrationProcess: vi.fn(),
    reportChromeCalls: vi.fn(),
    onChromeDisabled: (listener: (threadId: string, generation: string) => void) => {
      disabled.add(listener);
      return () => disabled.delete(listener);
    },
  };
  const codex = {
    pid: vi.fn((): number | undefined => 4242),
    listServer: vi.fn(async (): Promise<unknown> => ({ name: "node_repl", tools })),
    reload: vi.fn(async () => undefined),
    callTool: vi.fn(async () => ({})),
    providerThreadId: vi.fn((): string | undefined => "codex-thread"),
  };
  const states: Array<[string, string | undefined]> = [];
  const policy = { enabled: true };
  const session = new CodexChromeSession({
    threadId: "thread-1",
    generation: "gen-1",
    installation,
    userHome: "/Users/me",
    broker: broker as never,
    codex,
    policyEnabled: async () => policy.enabled,
    stateChanged: (state, detail) => states.push([state, detail]),
    inspect: vi.fn(async () => installation) as never,
    registrationsUnchanged: async () => true,
    setTimeout: (run, ms) => {
      expect(ms).toBe(CODEX_CHROME_IDLE_MS);
      timer = run;
      return run;
    },
    clearTimeout: () => {
      timer = undefined;
    },
    ...overrides,
  });
  const lastToken = () =>
    (broker.adoptIntegrationProcess.mock.calls.at(-1) as unknown as [{ launchToken: string }])[0]
      .launchToken;
  return {
    session,
    handoff: () => broker.registerCodexHandoff.mock.calls[0]![2],
    broker,
    codex,
    pause,
    policy,
    states,
    lastToken,
    stopped: () => broker.stopIntegrationProcess.mock.calls.map((call) => call[0] as string),
    setGeneration: (next: string) => {
      generation = next;
    },
    disable: (threadId = "thread-1", gen = "gen-1") => {
      for (const listener of disabled) listener(threadId, gen);
    },
    idle: () => timer?.(),
    idleArmed: () => timer !== undefined,
    release: () => releasers.get("thread-1\u0000gen-1")?.release() ?? false,
    releaserIdle: () => releasers.get("thread-1\u0000gen-1")?.idle() ?? false,
  };
}

async function ready(h: ReturnType<typeof harness>) {
  h.session.startupStatus("ready");
  await flush();
}

describe("CodexChromeSession", () => {
  it("parks an unused browser for native work, waits for exit, and stays parked across turns", async () => {
    const h = harness();
    await ready(h);
    await h.session.beforeTurn();
    let exited!: () => void;
    h.broker.waitForChromeRelease.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          exited = resolve;
        }),
    );
    let admitted = false;
    const parked = h
      .handoff()
      .native(performance.now() + 1000, async () => {})
      .then(() => {
        admitted = true;
      });
    await vi.waitFor(() => expect(h.broker.waitForChromeRelease).toHaveBeenCalled());
    expect(h.stopped()).toHaveLength(1);
    expect(admitted).toBe(false);
    exited();
    await parked;
    h.session.turnEnded("turn-1");
    await h.session.beforeTurn();
    expect(h.codex.reload).not.toHaveBeenCalled();
    expect(h.handoff().status()).toMatchObject({ state: "parked-for-native" });
  });

  it("waits for a browser call before stopping its runtime", async () => {
    const h = harness();
    await ready(h);
    h.session.toolCall("call", true);
    const parked = h.handoff().native(performance.now() + 1000, async () => {});
    await flush();
    expect(h.stopped()).toEqual([]);
    h.session.toolCall("call", false);
    await parked;
    expect(h.stopped()).toHaveLength(1);
  });

  it("does not kill an active browser call when its handoff deadline expires", async () => {
    const h = harness();
    await ready(h);
    h.session.toolCall("call", true);
    await expect(h.handoff().native(performance.now() + 5, async () => {})).rejects.toThrow(
      "timed out",
    );
    expect(h.stopped()).toEqual([]);
    h.session.toolCall("call", false);
  });

  it("reserves Chrome and drains other MCP work before a same-turn restart", async () => {
    const waitForMcpIdle = vi.fn(async () => {});
    const h = harness({ waitForMcpIdle });
    await ready(h);
    await h.session.beforeTurn();
    await h.handoff().native(performance.now() + 1000, async () => {});
    h.codex.reload.mockImplementation(async () => {
      h.session.startupStatus("ready");
    });
    await h.handoff().browser(performance.now() + 1000, async () => {});
    expect(waitForMcpIdle).toHaveBeenCalledOnce();
    expect(h.broker.prepareCodexBrowser).toHaveBeenCalledOnce();
    expect(h.codex.reload).toHaveBeenCalledOnce();
    expect(h.session.state).toBe("ready");
    expect(h.handoff().status()).toEqual({ state: "ready" });
  });

  it("keeps a failed restart parked and releases its reservation", async () => {
    const h = harness();
    await ready(h);
    await h.handoff().native(performance.now() + 1000, async () => {});
    h.codex.reload.mockRejectedValueOnce(new Error("reload failed"));
    await expect(h.handoff().browser(performance.now() + 1000, async () => {})).rejects.toThrow(
      "did not become ready",
    );
    expect(h.handoff().status().state).toBe("parked-for-native");
    expect(h.broker.host.send).toHaveBeenCalledWith(
      expect.objectContaining({ type: "chromeLeaseRelease" }),
    );
    await h.session.beforeTurn();
    expect(h.codex.reload).toHaveBeenCalledTimes(1);
  });

  it("still permits native handoff when Chrome was turned off", async () => {
    const h = harness();
    await ready(h);
    h.policy.enabled = false;
    h.disable();
    await h.handoff().native(performance.now() + 1000, async () => {});
    expect(h.handoff().status()).toMatchObject({
      state: "off",
      nextAction: expect.stringContaining("Enable Chrome"),
    });
    await expect(h.handoff().browser(performance.now() + 1000, async () => {})).rejects.toThrow(
      "Turned off",
    );
  });

  it("keeps native handoff parked after Pause and Resume", async () => {
    const h = harness();
    await ready(h);
    h.pause.set("thread-1", true);
    h.pause.set("thread-1", false);
    await h.handoff().native(performance.now() + 1000, async () => {});
    await h.session.beforeTurn();
    expect(h.codex.reload).not.toHaveBeenCalled();
  });
  it("retains actionable browser failures while still permitting native work", async () => {
    const h = harness();
    h.codex.listServer.mockResolvedValueOnce(undefined);
    await ready(h);
    expect(h.session.state).toBe("unavailable");
    await h.handoff().native(performance.now() + 1000, async () => {});
    expect(h.handoff().status()).toEqual({
      state: "unavailable",
      nextAction: "Codex didn't list the ChatGPT browser runtime's tools.",
    });
  });

  it("does not resume an old generation or bypass a paused checkpoint", async () => {
    const h = harness();
    await ready(h);
    h.setGeneration("replacement");
    await expect(h.handoff().native(performance.now() + 1000, async () => {})).rejects.toThrow(
      "ended",
    );
    await expect(h.handoff().browser(performance.now() + 1000, async () => {})).rejects.toThrow(
      "ended",
    );
    expect(h.codex.reload).not.toHaveBeenCalled();
  });

  it("preserves next-message Chrome restart for legacy threads without the host tool", async () => {
    const h = harness({ supportsBrowserResume: () => false });
    await ready(h);
    await h.handoff().native(performance.now() + 1000, async () => {});
    expect(h.handoff().status().nextAction).toContain("next message");
    h.codex.reload.mockImplementation(async () => {
      h.session.startupStatus("ready");
    });
    await h.session.beforeTurn();
    expect(h.session.state).toBe("ready");
  });

  it("adopts Codex's runtime, verifies it and holds the lease before it's connected", async () => {
    const h = harness();
    expect(h.states).toEqual([["pending", undefined]]);
    await ready(h);
    expect(h.broker.adoptIntegrationProcess).toHaveBeenCalledWith(
      expect.objectContaining({
        threadId: "thread-1",
        sessionGeneration: "gen-1",
        integration: "codex-chrome",
        parentPid: 4242,
        executable: "/plugin/bin/node_repl",
      }),
    );
    expect(h.broker.host.correlated).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "chromeLeaseAcquire",
        holder: expect.objectContaining({ threadId: "thread-1", provider: "codex" }),
      }),
      expect.any(Number),
      false,
    );
    expect(h.session.state).toBe("ready");
    expect(h.session.adopted).toBe(h.lastToken());
    expect(h.states.at(-1)).toEqual(["connected", undefined]);
    expect(h.idleArmed()).toBe(true);
  });

  it("stops and refuses a runtime whose tools differ from the record", async () => {
    const h = harness();
    h.codex.listServer.mockResolvedValue({
      tools: { ...tools, js: { name: "js", inputSchema: schema("other") } },
    });
    await ready(h);
    const token = h.lastToken();
    expect(h.stopped()).toContainEqual(token);
    expect(h.broker.host.correlated).not.toHaveBeenCalled();
    expect(h.session.state).toBe("unavailable");
    expect(h.states.at(-1)).toEqual(["unavailable", CODEX_CHROME_INVENTORY_CHANGED]);
  });

  it("reports a failed adoption and still stops its token and sweeps the runtime", async () => {
    const h = harness();
    // A timeout says nothing about what main did: it may still adopt the runtime.
    h.broker.adoptIntegrationProcess.mockRejectedValue(new Error("Timed out."));
    await ready(h);
    const requested = (
      h.broker.adoptIntegrationProcess.mock.calls[0] as unknown as [{ launchToken: string }]
    )[0].launchToken;
    expect(h.stopped()).toContainEqual(requested);
    // The sweep asks main to adopt whatever runs, so main stops it either way.
    expect(h.broker.adoptIntegrationProcess).toHaveBeenCalledTimes(2);
    expect(h.session.adopted).toBeUndefined();
    expect(h.states.at(-1)).toEqual(["unavailable", "Timed out."]);
  });

  it("stops the runtime for the turn when it isn't supervised in time", async () => {
    const h = harness({ startWaitMs: 5 });
    // Main never answers the adoption.
    h.broker.adoptIntegrationProcess.mockImplementationOnce(() => new Promise(() => {}));
    h.session.startupStatus("ready");
    await h.session.beforeTurn();
    expect(h.session.state).toBe("stopped");
    expect(h.states.at(-1)).toEqual(["pending", CODEX_CHROME_START_TIMED_OUT]);
    const pending = (
      h.broker.adoptIntegrationProcess.mock.calls[0] as unknown as [{ launchToken: string }]
    )[0].launchToken;
    // The late adoption is stopped, and whatever Codex runs is swept.
    expect(h.stopped()).toContainEqual(pending);
    await flush();
    expect(h.broker.adoptIntegrationProcess).toHaveBeenCalledTimes(2);
    expect(h.stopped()).toContainEqual(h.lastToken());
    expect(h.broker.host.correlated).not.toHaveBeenCalled();
  });

  it("stops the runtime for the turn when Codex never reports it", async () => {
    const h = harness({ startWaitMs: 5 });
    await h.session.beforeTurn();
    expect(h.session.state).toBe("stopped");
    expect(h.states.at(-1)).toEqual(["pending", CODEX_CHROME_START_TIMED_OUT]);
    // A runtime Codex reports later is stopped, not adopted.
    h.session.startupStatus("ready");
    await flush();
    expect(h.stopped()).toContainEqual(h.lastToken());
    expect(h.session.state).toBe("stopped");
  });

  it("reports Codex's own startup failure", () => {
    const h = harness();
    h.session.startupStatus("failed", "spawn ENOENT");
    expect(h.broker.adoptIntegrationProcess).not.toHaveBeenCalled();
    expect(h.states.at(-1)).toEqual(["unavailable", "spawn ENOENT"]);
  });

  it("stops the runtime and releases the lease on pause, policy-off and idle", async () => {
    for (const [trigger, state, detail] of [
      ["pause", "pending", CODEX_CHROME_STOPPED_PAUSED],
      ["off", "off", CODEX_CHROME_STOPPED_OFF],
      ["idle", "pending", CODEX_CHROME_STOPPED_IDLE],
    ] as const) {
      const h = harness();
      await ready(h);
      const token = h.lastToken();
      if (trigger === "pause") h.pause.set("thread-1", true);
      else if (trigger === "off") h.disable();
      else h.idle();
      // Only the idle stop is graceful; pause and turning it off stop at once.
      expect(h.broker.stopIntegrationProcess).toHaveBeenCalledWith(
        token,
        trigger === "idle" ? "release" : undefined,
      );
      expect(h.broker.host.send).toHaveBeenCalledWith(
        expect.objectContaining({ type: "chromeLeaseRelease" }),
      );
      expect(h.session.state).toBe("stopped");
      expect(h.session.adopted).toBeUndefined();
      expect(h.states.at(-1)).toEqual([state, detail]);
    }
  });

  it("gives Chrome up to another thread only while idle", async () => {
    const h = harness();
    await ready(h);
    const turn = h.session.beforeTurn();
    await turn;
    // Mid-turn: refused, the runtime keeps running.
    expect(h.releaserIdle()).toBe(false);
    expect(h.release()).toBe(false);
    h.session.turnEnded("turn-1");
    h.session.toolCall("call-1", true);
    // A call still running (reported late) also refuses.
    expect(h.releaserIdle()).toBe(false);
    expect(h.release()).toBe(false);
    h.session.toolCall("call-1", false);
    const token = h.lastToken();
    expect(h.releaserIdle()).toBe(true);
    expect(h.release()).toBe(true);
    expect(h.broker.stopIntegrationProcess).toHaveBeenCalledWith(token, "release");
    expect(h.session.state).toBe("stopped");
    expect(h.states.at(-1)).toEqual(["pending", CODEX_CHROME_STOPPED_RELEASED]);
    // Already stopped: nothing more to give up.
    expect(h.release()).toBe(false);
  });

  it("never idle-stops during a turn, however long before its first call", async () => {
    const h = harness();
    const turn = h.session.beforeTurn();
    // Adoption finishes while the turn waits for it.
    await ready(h);
    await turn;
    expect(h.session.state).toBe("ready");
    expect(h.idleArmed()).toBe(false);
    h.session.toolCall("call-1", true);
    expect(h.idleArmed()).toBe(false);
    h.session.turnEnded("turn-1");
    expect(h.idleArmed()).toBe(true);
    // A turn that never started arms it too.
    await h.session.beforeTurn();
    expect(h.idleArmed()).toBe(false);
    h.session.turnAborted();
    expect(h.idleArmed()).toBe(true);
  });

  it("stops a supervised runtime that Codex reports failed", async () => {
    const h = harness();
    await ready(h);
    const token = h.lastToken();
    h.session.startupStatus("cancelled");
    expect(h.stopped()).toContainEqual(token);
    expect(h.session.state).toBe("stopped");
  });

  it("ignores pauses and policy changes for other threads and generations", async () => {
    const h = harness();
    await ready(h);
    h.pause.set("thread-2", true);
    h.disable("thread-1", "gen-0");
    h.disable("thread-2", "gen-1");
    expect(h.broker.stopIntegrationProcess).not.toHaveBeenCalled();
    expect(h.session.state).toBe("ready");
  });

  it("restarts a stopped runtime before the next turn and adopts the new one", async () => {
    const h = harness();
    await ready(h);
    const first = h.lastToken();
    h.idle();
    h.codex.reload.mockImplementation(async () => {
      queueMicrotask(() => h.session.startupStatus("ready"));
    });
    await h.session.beforeTurn();
    expect(h.codex.reload).toHaveBeenCalledTimes(1);
    expect(h.broker.adoptIntegrationProcess).toHaveBeenCalledTimes(2);
    expect(h.lastToken()).not.toBe(first);
    expect(h.session.state).toBe("ready");
    expect(h.codex.listServer).toHaveBeenCalledTimes(2);
    expect(h.states.at(-1)).toEqual(["connected", undefined]);
  });

  it("doesn't restart while paused, turned off or in an ended session", async () => {
    for (const block of ["pause", "off", "generation"] as const) {
      const h = harness();
      await ready(h);
      h.idle();
      if (block === "pause") h.pause.set("thread-1", true);
      else if (block === "off") h.policy.enabled = false;
      else h.setGeneration("gen-2");
      await h.session.beforeTurn();
      expect(h.codex.reload).not.toHaveBeenCalled();
      expect(h.session.state).toBe("stopped");
      expect(h.states.at(-1)?.[0]).toBe(
        block === "pause" ? "pending" : block === "off" ? "off" : "unavailable",
      );
    }
  });

  it("re-checks the gates after adoption and stops a runtime they refuse", async () => {
    const h = harness();
    h.policy.enabled = false;
    await ready(h);
    expect(h.stopped()).toContainEqual(h.lastToken());
    expect(h.broker.host.correlated).not.toHaveBeenCalled();
    expect(h.states.at(-1)).toEqual(["off", CODEX_CHROME_STOPPED_OFF]);
  });

  it("undoes an adoption that a pause overtook", async () => {
    const h = harness();
    let finish: (() => void) | undefined;
    h.broker.adoptIntegrationProcess.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = () => resolve({} as never);
        }),
    );
    h.session.startupStatus("ready");
    await flush();
    h.pause.set("thread-1", true);
    finish?.();
    await flush();
    expect(h.stopped()).toContainEqual(h.lastToken());
    expect(h.broker.host.correlated).not.toHaveBeenCalled();
    expect(h.session.state).toBe("stopped");
  });

  it("stops a runtime Codex starts after the session stopped it", async () => {
    const h = harness();
    await ready(h);
    h.pause.set("thread-1", true);
    h.broker.stopIntegrationProcess.mockClear();
    h.session.startupStatus("ready");
    await flush();
    expect(h.broker.adoptIntegrationProcess).toHaveBeenCalledTimes(2);
    expect(h.stopped()).toContainEqual(h.lastToken());
    expect(h.session.state).toBe("stopped");
  });

  it("adopts and verifies a runtime Codex replaced on its own, under the same lease", async () => {
    const h = harness();
    await ready(h);
    const first = h.lastToken();
    const states = h.states.length;
    h.session.startupStatus("ready");
    await flush();
    expect(h.broker.adoptIntegrationProcess).toHaveBeenCalledTimes(2);
    const second = h.lastToken();
    expect(second).not.toBe(first);
    expect(h.stopped()).toEqual([first]);
    expect(h.session.adopted).toBe(second);
    expect(h.codex.listServer).toHaveBeenCalledTimes(2);
    expect(h.broker.host.send).not.toHaveBeenCalled();
    expect(h.session.state).toBe("ready");
    expect(h.states.length).toBe(states);
  });

  it("changes nothing when Codex repeats ready for the supervised runtime", async () => {
    const h = harness();
    await ready(h);
    const first = h.lastToken();
    // Main answers with the registration that already supervises it.
    h.broker.adoptIntegrationProcess.mockResolvedValueOnce({ launchToken: first });
    h.session.startupStatus("ready");
    await flush();
    expect(h.stopped()).toEqual([]);
    expect(h.session.adopted).toBe(first);
    expect(h.codex.listServer).toHaveBeenCalledTimes(1);
    expect(h.session.state).toBe("ready");
  });

  it("stops a replacement whose tools differ from the record", async () => {
    const h = harness();
    await ready(h);
    h.codex.listServer.mockResolvedValue({ tools: { js: tools.js } });
    h.session.startupStatus("ready");
    await flush();
    expect(h.stopped()).toContainEqual(h.lastToken());
    expect(h.states.at(-1)).toEqual(["unavailable", CODEX_CHROME_INVENTORY_CHANGED]);
  });

  it("drains each ended turn once through turn_ended and then arms the idle stop", async () => {
    const h = harness();
    await ready(h);
    h.session.toolCall("call-1", true);
    expect(h.idleArmed()).toBe(false);
    h.session.turnEnded("turn-1");
    h.session.turnEnded("turn-1");
    expect(h.codex.callTool).toHaveBeenCalledTimes(1);
    expect(h.codex.callTool).toHaveBeenCalledWith(
      "turn_ended",
      { hook_event_name: "Stop", session_id: "codex-thread", turn_id: "turn-1" },
      {},
    );
    expect(h.idleArmed()).toBe(true);
  });

  it("tracks the model's running calls until they complete or their turn ends", async () => {
    const h = harness();
    await ready(h);
    expect(h.session.callRunning).toBe(false);
    h.session.toolCall("call-1", true);
    h.session.toolCall("call-2", true);
    h.session.toolCall("call-1", false);
    expect(h.session.callRunning).toBe(true);
    h.session.toolCall("call-2", false);
    expect(h.session.callRunning).toBe(false);
    h.session.toolCall("call-3", true);
    h.session.turnEnded("turn-1");
    expect(h.session.callRunning).toBe(false);
  });

  it("reports whether a call is running from before it acquires the lease until it releases it", async () => {
    const h = harness();
    h.session.toolCall("early", true);
    h.session.toolCall("early", false);
    // Nothing is reported before the runtime is verified.
    expect(h.broker.reportChromeCalls).not.toHaveBeenCalled();
    await ready(h);
    const acquire = h.broker.host.correlated.mock.invocationCallOrder[0]!;
    // Idle is reported before main announces the lease, so it never reads as unknown.
    expect(h.broker.reportChromeCalls.mock.invocationCallOrder[0]).toBeLessThan(acquire);
    h.session.toolCall("call-1", true);
    h.session.toolCall("call-1", false);
    h.session.toolCall("call-2", true);
    h.session.turnEnded("turn-1");
    h.idle();
    expect(h.broker.reportChromeCalls.mock.calls.map((call) => call[2])).toEqual([
      false,
      false,
      true,
      false,
      true,
      false,
      // Released: idle while main drains; the broker drops it when the lease ends.
      false,
    ]);
    expect(h.broker.reportChromeCalls.mock.calls.every((call) => call[1] === "gen-1")).toBe(true);
    h.session.toolCall("call-3", true);
    expect(h.broker.reportChromeCalls).toHaveBeenCalledTimes(7);
  });

  it("reports idle on every release path, even during a call", async () => {
    for (const trigger of ["pause", "off", "interrupt"] as const) {
      const h = harness();
      await ready(h);
      h.session.toolCall("call-1", true);
      if (trigger === "pause") h.pause.set("thread-1", true);
      else if (trigger === "off") h.disable();
      else h.session.turnInterrupted("turn-1", true);
      expect(h.session.state).toBe("stopped");
      expect(h.broker.reportChromeCalls.mock.calls.at(-1)).toEqual(["thread-1", "gen-1", false]);
    }
  });

  it("withdraws its report when the lease isn't acquired", async () => {
    const h = harness();
    h.broker.host.correlated.mockRejectedValueOnce(new Error("busy"));
    await ready(h);
    expect(h.broker.reportChromeCalls.mock.calls).toEqual([
      ["thread-1", "gen-1", false],
      ["thread-1", "gen-1", undefined],
    ]);
  });

  it("drains a turn interrupted between calls and keeps the runtime", async () => {
    const h = harness();
    await ready(h);
    await h.session.beforeTurn();
    h.session.turnInterrupted("turn-1", false);
    expect(h.codex.callTool).toHaveBeenCalledWith(
      "turn_ended",
      { hook_event_name: "Stop", session_id: "codex-thread", turn_id: "turn-1" },
      {},
    );
    expect(h.stopped()).toEqual([]);
    expect(h.session.state).toBe("ready");
    expect(h.idleArmed()).toBe(true);
  });

  it("stops the runtime when a turn is interrupted during a call, and restarts it next turn", async () => {
    const h = harness();
    await ready(h);
    await h.session.beforeTurn();
    const token = h.lastToken();
    h.session.toolCall("call-1", true);
    h.session.turnInterrupted("turn-1", h.session.callRunning);
    expect(h.stopped()).toEqual([token]);
    // Killed at once, not after the graceful release's grace.
    expect(h.broker.stopIntegrationProcess.mock.calls.at(-1)?.[1]).toBeUndefined();
    expect(h.session.state).toBe("stopped");
    expect(h.states.at(-1)).toEqual(["pending", CODEX_CHROME_STOPPED_INTERRUPTED]);
    expect(h.session.callRunning).toBe(false);
    // Codex then reports the interrupted turn completed: nothing to drain.
    h.session.turnEnded("turn-1");
    expect(h.codex.callTool).not.toHaveBeenCalled();
    expect(h.idleArmed()).toBe(false);
    const turn = h.session.beforeTurn();
    await flush();
    expect(h.codex.reload).toHaveBeenCalledTimes(1);
    await ready(h);
    await turn;
    expect(h.session.state).toBe("ready");
    expect(h.lastToken()).not.toBe(token);
  });

  it("releases everything once on dispose", async () => {
    const h = harness();
    await ready(h);
    const token = h.lastToken();
    h.session.dispose();
    h.session.dispose();
    h.pause.set("thread-1", true);
    expect(h.broker.stopIntegrationProcess).toHaveBeenCalledTimes(1);
    expect(h.stopped()).toContainEqual(token);
    expect(h.session.state).toBe("disposed");
  });

  it("reads tools from either schema key Codex lists", () => {
    expect(
      listedTools({ tools: { js: { input_schema: { type: "object" }, description: "Run" } } }),
    ).toEqual([{ name: "js", description: "Run", inputSchema: { type: "object" } }]);
    expect(listedTools({})).toBeUndefined();
    expect(listedTools({ tools: { js: 1 } })).toBeUndefined();
  });
});
