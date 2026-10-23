import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { spawnRegisteredProcess } from "../provider/registeredIntegrationProcess";
import {
  IntegrationProxySession,
  toolInventorySha256,
  type IntegrationProxyDeps,
} from "./IntegrationProxyCatalog";

const FIXTURE = fileURLToPath(new URL("./fixtures/integration-server.mjs", import.meta.url));
const schema = { type: "object", properties: { code: { type: "string" } } };
const inventory = (names: string[]) =>
  toolInventorySha256(names.map((name) => ({ name, inputSchema: schema })));

const sessions: IntegrationProxySession[] = [];
afterEach(async () => {
  await Promise.all(sessions.splice(0).map((session) => session.dispose()));
});

function setup(patch: Partial<IntegrationProxyDeps> & { env?: NodeJS.ProcessEnv } = {}) {
  // Mirrors main: acquisition is idempotent per holder, release clears it.
  const state = {
    policy: true,
    paused: false,
    generation: "g1" as string | undefined,
    held: false,
  };
  const acquireLease = vi.fn(async () => {
    state.held = true;
  });
  const releaseLease = vi.fn(() => {
    state.held = false;
  });
  const consent = vi.fn(async () => true);
  const exited = vi.fn();
  const spawn = vi.fn(spawnRegisteredProcess);
  const session = new IntegrationProxySession({
    integration: "codex-chrome",
    threadId: "t",
    generation: "g1",
    command: process.execPath,
    args: [FIXTURE],
    env: {
      PATH: process.env.PATH ?? "",
      FIXTURE_TOOLS: '["js","js_reset","extra"]',
      ...patch.env,
    },
    allowedTools: ["js", "js_reset"],
    toolInventorySha256: inventory(["js", "js_reset", "extra"]),
    advertisedTools: [
      { name: "js", inputSchema: schema },
      { name: "js_reset", inputSchema: schema },
    ],
    identity: {
      profileId: "p",
      backendIncarnation: "i",
      threadId: "t",
      sessionGeneration: "g1",
      integration: "codex-chrome",
    },
    register: async () => {},
    exited,
    policyEnabled: async () => state.policy,
    currentGeneration: () => state.generation,
    paused: () => state.paused,
    consent,
    acquireLease,
    releaseLease,
    spawn,
    drainKillMs: 200,
    teardownKillMs: 200,
    ...patch,
  });
  sessions.push(session);
  return { session, state, acquireLease, releaseLease, consent, exited, spawn };
}
const text = (result: { content: ReadonlyArray<{ type: string; text?: string }> }) =>
  result.content.map((block) => block.text ?? "").join("");

describe("integration proxy", () => {
  it("lists the record's tools without starting the child, then verifies a paged, reordered inventory", async () => {
    const { session, spawn, consent } = setup({
      env: { FIXTURE_REVERSE: "1", FIXTURE_PAGE_SIZE: "2" },
    });
    expect((await session.listTools()).map((tool) => tool.name)).toEqual(["js", "js_reset"]);
    expect(spawn).not.toHaveBeenCalled();
    expect(consent).not.toHaveBeenCalled();
    expect(text(await session.callTool("js", { code: "a" }))).toBe("ran a");
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it("re-checks the installation before every spawn and never starts a changed one", async () => {
    let changed: string | undefined;
    const beforeSpawn = vi.fn(async () => changed);
    const { session, spawn } = setup({ beforeSpawn, idleStopMs: 50 });
    expect(text(await session.callTool("js", { code: "a" }))).toBe("ran a");
    // The idle child stops; an app update lands before the next spawn.
    await vi.waitFor(() => expect(session.inFlight).toEqual([]));
    await new Promise((resolve) => setTimeout(resolve, 150));
    changed = "The ChatGPT app changed since this session started.";
    expect(text(await session.callTool("js", { code: "b" }))).toContain("app changed");
    expect(beforeSpawn).toHaveBeenCalledTimes(2);
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it("never spawns when the user declines consent", async () => {
    const { session, spawn } = setup({ consent: async () => false });
    expect(text(await session.callTool("js", { code: "a" }))).toContain("didn't allow");
    expect(spawn).not.toHaveBeenCalled();
  });

  it("denies every call until the inventory matches the record", async () => {
    const { session, acquireLease } = setup({ toolInventorySha256: inventory(["js"]) });
    const result = await session.callTool("js", { code: "1" });
    expect(result.isError).toBe(true);
    expect(text(result)).toContain("tools changed");
    expect(acquireLease).not.toHaveBeenCalled();
    const uncertified = setup({ toolInventorySha256: undefined });
    expect((await uncertified.session.callTool("js", { code: "1" })).isError).toBe(true);
    const misadvertised = setup({
      advertisedTools: [{ name: "js", inputSchema: { type: "object" } }],
    });
    expect(text(await misadvertised.session.callTool("js", { code: "1" }))).toContain(
      "tools changed",
    );
  });

  it("forwards an admitted call under the lease and asks consent once", async () => {
    const { session, state, releaseLease, consent } = setup();
    expect(text(await session.callTool("js", { code: "a" }))).toBe("ran a");
    expect(text(await session.callTool("js", { code: "b" }))).toBe("ran b");
    expect(consent).toHaveBeenCalledTimes(1);
    // Held for the child's life, not per call: code a call started can outlive it.
    expect(releaseLease).not.toHaveBeenCalled();
    expect(state.held).toBe(true);
    expect(text(await session.callTool("extra", {}))).toContain("isn't allowed");
  });

  it("stops an idle child and releases the lease once it has exited", async () => {
    const { session, state, exited } = setup({ idleStopMs: 100 });
    expect(text(await session.callTool("js", { code: "a" }))).toBe("ran a");
    expect(state.held).toBe(true);
    await vi.waitFor(() => expect(exited).toHaveBeenCalledTimes(1));
    expect(state.held).toBe(false);
    // The next call starts a new child without asking again.
    expect(text(await session.callTool("js", { code: "b" }))).toBe("ran b");
  });

  it("stops an idle child even when no call ever took the lease", async () => {
    const { session, acquireLease, exited } = setup({ idleStopMs: 100 });
    expect(text(await session.callTool("extra", {}))).toContain("isn't allowed");
    expect(acquireLease).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(exited).toHaveBeenCalledTimes(1));
  });

  it("never forwards a call cancelled while consent is pending", async () => {
    let answer: (allowed: boolean) => void = () => undefined;
    const { session, spawn, acquireLease } = setup({
      consent: () =>
        new Promise<boolean>((resolve) => {
          answer = resolve;
        }),
    });
    const pending = session.callTool("js", { code: "a" }, "c1");
    await vi.waitFor(() => expect(session.inFlight).toHaveLength(1));
    session.cancelCall("c1");
    answer(true);
    expect(text(await pending)).toContain("interrupted");
    expect(spawn).not.toHaveBeenCalled();
    expect(acquireLease).not.toHaveBeenCalled();
  });

  it("never forwards a call cancelled while the inventory is being verified", async () => {
    const { session, spawn, acquireLease } = setup({ env: { FIXTURE_INIT_DELAY: "150" } });
    const pending = session.callTool("js", { code: "a" }, "c1");
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledTimes(1));
    session.cancel();
    expect(text(await pending)).toContain("interrupted");
    expect(acquireLease).not.toHaveBeenCalled();
    // Pause also stopped the child; a fresh one has received no call at all.
    expect(text(await session.callTool("js", { code: "count" }))).toBe("calls 0");
  });

  it("checks live policy, pause and generation on every call", async () => {
    const { session, state, acquireLease } = setup();
    state.policy = false;
    expect(text(await session.callTool("js", { code: "a" }))).toContain("turned off");
    state.policy = true;
    state.paused = true;
    expect(text(await session.callTool("js", { code: "a" }))).toContain("paused");
    state.paused = false;
    state.generation = "g2";
    expect(text(await session.callTool("js", { code: "a" }))).toContain("unavailable");
    expect(acquireLease).not.toHaveBeenCalled();
  });

  it("rechecks policy after the lease wait and never forwards a revoked call", async () => {
    const { session, state } = setup({
      acquireLease: async () => {
        state.held = true;
        // The user turns the integration off while ownership is being taken.
        state.policy = false;
      },
    });
    const result = await session.callTool("js", { code: "a" });
    expect(text(result)).toContain("turned off");
    expect(session.inFlight).toEqual([]);
    // The child is stopped and ownership ends once it has exited.
    await vi.waitFor(() => expect(state.held).toBe(false));
  });

  it("re-verifies after tools/list_changed without initializing the child again", async () => {
    const { session, spawn } = setup();
    // The fixture rejects a second `initialize`, as MCP allows only one per connection.
    expect(text(await session.callTool("js", { code: "touch" }))).toBe("ran touch");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(text(await session.callTool("js", { code: "a" }))).toBe("ran a");
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(text(await session.callTool("js", { code: "change" }))).toBe("ran change");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(text(await session.callTool("js", { code: "a" }))).toContain("tools changed");
  });

  it("drops a late response after the generation changes", async () => {
    const { session, state } = setup();
    const pending = session.callTool("js", { code: "slow" });
    await vi.waitFor(() =>
      expect(session.inFlight).toEqual([expect.objectContaining({ state: "forwarded" })]),
    );
    state.generation = "g2";
    expect(text(await pending)).toContain("discarded");
    expect(session.inFlight).toEqual([]);
  });

  it("stops the child and its background work on pause, then releases", async () => {
    const markerDir = mkdtempSync(join(tmpdir(), "f5-proxy-"));
    onTestFinished(() => rmSync(markerDir, { recursive: true, force: true }));
    const marker = join(markerDir, "marker");
    writeFileSync(marker, "");
    const { session, state, exited } = setup({ env: { FIXTURE_MARKER: marker } });
    expect(text(await session.callTool("js", { code: "worker" }))).toBe("ran worker");
    await vi.waitFor(() => expect(readFileSync(marker, "utf8").length).toBeGreaterThan(2));
    const pending = session.callTool("js", { code: "hang" });
    await vi.waitFor(() =>
      expect(session.inFlight).toEqual([expect.objectContaining({ state: "forwarded" })]),
    );
    session.cancel();
    expect(session.inFlight[0]?.state).toBe("cancelled");
    // Ownership stays until the child has exited.
    expect(state.held).toBe(true);
    expect((await pending).isError).toBe(true);
    await vi.waitFor(() => expect(exited).toHaveBeenCalledTimes(1));
    expect(state.held).toBe(false);
    const stopped = readFileSync(marker, "utf8").length;
    await new Promise((resolve) => setTimeout(resolve, 150));
    // The worker shared the child's process group and was stopped with it.
    expect(readFileSync(marker, "utf8").length).toBe(stopped);
  });

  it("kills a child that streams an oversized line", async () => {
    const { session, exited } = setup({ maxLineBytes: 16 * 1024 });
    expect(text(await session.callTool("js", { code: "flood" }))).toContain("oversized");
    await vi.waitFor(() => expect(exited).toHaveBeenCalledTimes(1));
  });

  it("cancels the one call a client names and stops a call past its deadline", async () => {
    const { session, state } = setup({ callTimeoutMs: 300 });
    expect(text(await session.callTool("js", { code: "warm" }, "warm"))).toBe("ran warm");
    const named = session.callTool("js", { code: "hang" }, "c1");
    await vi.waitFor(() =>
      expect(session.inFlight).toEqual([expect.objectContaining({ state: "forwarded" })]),
    );
    session.cancelCall("c1");
    expect(session.inFlight[0]?.state).toBe("cancelled");
    expect((await named).isError).toBe(true);
    await vi.waitFor(() => expect(state.held).toBe(false));

    const late = await session.callTool("js", { code: "hang" }, "c2");
    expect(text(late)).toContain("took too long");
    // The lease outlives the deadline until the drained child exits.
    await vi.waitFor(() => expect(state.held).toBe(false));
  });

  it("shares one lease across parallel calls and releases it only when the child exits", async () => {
    const { session, state, releaseLease } = setup();
    const slow = session.callTool("js", { code: "slow" }, "slow");
    await vi.waitFor(() =>
      expect(session.inFlight).toEqual([expect.objectContaining({ state: "forwarded" })]),
    );
    expect(text(await session.callTool("js", { code: "fast" }, "fast"))).toBe("ran fast");
    expect(text(await slow)).toBe("ran slow");
    const results = await Promise.all(
      ["a", "b", "c"].map((code) => session.callTool("js", { code }, `call-${code}`)),
    );
    expect(results.map(text)).toEqual(["ran a", "ran b", "ran c"]);
    expect(state.held).toBe(true);
    expect(releaseLease).not.toHaveBeenCalled();
    await session.dispose();
    expect(state.held).toBe(false);
    expect(releaseLease).toHaveBeenCalledTimes(1);
  });

  it("answers server-initiated requests instead of leaving the child waiting", async () => {
    const { session } = setup();
    expect(text(await session.callTool("js", { code: "ask" }))).toBe("answered -32601");
  });

  it("tears the child down on dispose and refuses further calls", async () => {
    const { session, exited } = setup();
    await session.callTool("js", { code: "a" });
    await session.dispose();
    expect(exited).toHaveBeenCalledTimes(1);
    expect(text(await session.callTool("js", { code: "a" }))).toContain("ended");
    expect(await session.listTools()).toEqual([]);
  });
});
