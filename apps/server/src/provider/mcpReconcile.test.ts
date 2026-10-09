import { describe, expect, it, vi } from "vitest";

import {
  codexObservedMcpStatus,
  reconcileClaudeMcpServers,
  stableMcpConfigKey,
  summarizeMcpReload,
} from "./mcpReconcile.ts";

type Status = { name: string; status: string; error?: string; source?: string };

/**
 * Mirrors Claude CLI 2.1.292 as observed live: servers passed at launch
 * (`launch`) report as dynamic but survive omission; naming one replaces it,
 * after which it can be removed like any `setMcpServers` server.
 */
function fakeQuery(initial: Status[], connect: (name: string) => Status, launch: string[] = []) {
  let statuses = [...initial];
  const pinned = new Set(launch);
  const setMcpServers = vi.fn(async (servers: Record<string, unknown>) => {
    for (const name of Object.keys(servers)) pinned.delete(name);
    const dynamic = statuses.filter((status) => status.source === "dynamic");
    const removed = dynamic
      .filter((status) => !(status.name in servers) && !pinned.has(status.name))
      .map((s) => s.name);
    const added = Object.keys(servers).filter((name) => !dynamic.some((s) => s.name === name));
    statuses = statuses.filter((status) => !removed.includes(status.name));
    const errors: Record<string, string> = {};
    for (const name of added) {
      const next = connect(name);
      statuses.push(next);
      if (next.status === "failed") errors[name] = next.error ?? "failed";
    }
    return { added, removed, errors };
  });
  const reconnectMcpServer = vi.fn(async (name: string) => {
    statuses = statuses.map((status) => (status.name === name ? connect(name) : status));
  });
  return {
    query: {
      mcpServerStatus: async () => statuses,
      setMcpServers,
      reconnectMcpServer,
    },
    setMcpServers,
    reconnectMcpServer,
  };
}

describe("reconcileClaudeMcpServers", () => {
  it("never names settings or plugin servers, so omission cannot remove them", async () => {
    const fake = fakeQuery(
      [
        { name: "settings-server", status: "connected", source: "project" },
        { name: "plugin-server", status: "connected", source: "plugin" },
        { name: "old-f5", status: "connected", source: "dynamic" },
      ],
      (name) => ({ name, status: "connected", source: "dynamic" }),
    );

    const outcome = await reconcileClaudeMcpServers({
      query: fake.query,
      desired: { "new-f5": { type: "stdio", command: "x" }, "plugin-server": { type: "stdio" } },
      owned: new Set(["old-f5"]),
    });

    expect(fake.setMcpServers).toHaveBeenCalledWith({ "new-f5": { type: "stdio", command: "x" } });
    expect([...outcome.owned]).toEqual(["new-f5"]);
    // The name conflict is visible but does not block convergence.
    expect(outcome.result.converged).toBe(true);
    expect(outcome.result.errors).toEqual([
      {
        server: "plugin-server",
        message: "A plugin server already uses this name; F5 left it in place.",
      },
    ]);
    expect(outcome.result.servers.map((server) => [server.name, server.owned])).toEqual([
      ["settings-server", false],
      ["plugin-server", false],
      ["new-f5", true],
    ]);
  });

  it("refreshes observed status after a partial failure and reconnects on the next attempt", async () => {
    let healthy = false;
    const fake = fakeQuery([], (name) =>
      healthy
        ? { name, status: "connected", source: "dynamic" }
        : { name, status: "failed", error: "spawn ENOENT", source: "dynamic" },
    );
    const desired = { flaky: { type: "stdio" } };

    const first = await reconcileClaudeMcpServers({
      query: fake.query,
      desired,
      owned: new Set(),
    });
    expect(first.result.converged).toBe(false);
    expect(first.result.restartRequired).toBe(false);
    expect(first.result.servers).toEqual([
      { name: "flaky", status: "failed", owned: true, error: "spawn ENOENT" },
    ]);
    expect(first.result.errors).toEqual([{ server: "flaky", message: "spawn ENOENT" }]);

    healthy = true;
    const second = await reconcileClaudeMcpServers({
      query: fake.query,
      desired,
      owned: first.owned,
    });
    expect(fake.reconnectMcpServer).toHaveBeenCalledWith("flaky");
    expect(second.result.converged).toBe(true);
  });

  it("requires a restart to drop a server F5 passed at launch, until the session restarts", async () => {
    const fake = fakeQuery(
      [
        { name: "keep", status: "connected", source: "dynamic" },
        { name: "drop", status: "connected", source: "dynamic" },
      ],
      (name) => ({ name, status: "connected", source: "dynamic" }),
      ["keep", "drop"],
    );

    const first = await reconcileClaudeMcpServers({
      query: fake.query,
      desired: { keep: { v: 2 } },
      owned: new Set(["keep", "drop"]),
    });
    expect(first.result).toMatchObject({ converged: false, restartRequired: true });
    expect(first.result.errors).toEqual([
      { server: "drop", message: "Claude keeps this server until the session restarts." },
    ]);
    expect([...first.owned].toSorted()).toEqual(["drop", "keep"]);
    // In-process recovery relaunches with only the desired servers.
    expect(first.applied).toEqual({ keep: { v: 2 } });

    // A later reconcile still reports the pending restart.
    const second = await reconcileClaudeMcpServers({
      query: fake.query,
      desired: { keep: { v: 2 } },
      owned: first.owned,
    });
    expect(second.result.restartRequired).toBe(true);
  });

  it("keeps ownership and requires a restart when the status read fails after a removal", async () => {
    const fake = fakeQuery(
      [
        { name: "keep", status: "connected", source: "dynamic" },
        { name: "drop", status: "connected", source: "dynamic" },
      ],
      (name) => ({ name, status: "connected", source: "dynamic" }),
      ["drop"],
    );
    let reads = 0;
    const query = {
      ...fake.query,
      mcpServerStatus: async () => {
        reads += 1;
        if (reads > 1) throw new Error("status unavailable");
        return fake.query.mcpServerStatus();
      },
    };

    const outcome = await reconcileClaudeMcpServers({
      query,
      desired: { keep: {} },
      owned: new Set(["keep", "drop"]),
    });
    expect(outcome.result).toMatchObject({ converged: false, restartRequired: true });
    expect([...outcome.owned].toSorted()).toEqual(["drop", "keep"]);
  });

  it("trusts the CLI's removed list when the status read fails", async () => {
    const fake = fakeQuery([{ name: "old", status: "connected", source: "dynamic" }], (name) => ({
      name,
      status: "connected",
      source: "dynamic",
    }));
    let reads = 0;
    const outcome = await reconcileClaudeMcpServers({
      query: {
        ...fake.query,
        mcpServerStatus: async () => {
          reads += 1;
          if (reads > 1) throw new Error("status unavailable");
          return fake.query.mcpServerStatus();
        },
      },
      desired: {},
      owned: new Set(["old"]),
    });
    expect([...outcome.owned]).toEqual([]);
    // Unverified, so retried rather than converged, but no restart is needed.
    expect(outcome.result).toMatchObject({ converged: false, restartRequired: false });
  });

  it("requires a restart when the runtime cannot change servers in place", async () => {
    const unsupported = await reconcileClaudeMcpServers({
      query: { mcpServerStatus: async () => [] },
      desired: {},
      owned: new Set(),
    });
    expect(unsupported.result).toMatchObject({ converged: false, restartRequired: true });
    expect(unsupported.applied).toBeUndefined();

    const rejected = await reconcileClaudeMcpServers({
      query: {
        mcpServerStatus: async () => [],
        setMcpServers: async () => {
          throw new Error("Unsupported control request");
        },
      },
      desired: { a: {} },
      owned: new Set(),
    });
    expect(rejected.result.restartRequired).toBe(true);
    expect(rejected.owned.size).toBe(0);
  });
});

describe("summarizeMcpReload", () => {
  it("counts pending and needs-auth servers as applied but missing ones as not converged", () => {
    expect(
      summarizeMcpReload({
        desired: ["a", "b"],
        observed: [
          { name: "a", status: "pending" },
          { name: "b", status: "needs-auth" },
        ],
      }).converged,
    ).toBe(true);
    const missing = summarizeMcpReload({ desired: ["a"], observed: [] });
    expect(missing.converged).toBe(false);
    expect(missing.errors[0]?.server).toBe("a");
    // Without observed status the result rests on request errors alone.
    expect(summarizeMcpReload({ desired: ["a"], observed: undefined }).converged).toBe(true);
  });

  it("keys MCP configs independently of key order", () => {
    expect(stableMcpConfigKey({ b: { url: "u", type: "http" }, a: { command: "x" } })).toBe(
      stableMcpConfigKey({ a: { command: "x" }, b: { type: "http", url: "u" } }),
    );
    expect(stableMcpConfigKey({ a: { command: "x" } })).not.toBe(
      stableMcpConfigKey({ a: { command: "y" } }),
    );
  });

  it("maps Codex startup status", () => {
    expect(codexObservedMcpStatus({ startupStatus: "ready" })).toBe("connected");
    expect(codexObservedMcpStatus({ startupStatus: "starting" })).toBe("pending");
    expect(codexObservedMcpStatus({ authStatus: "notLoggedIn" })).toBe("needs-auth");
    expect(codexObservedMcpStatus({ error: "boom" })).toBe("failed");
    expect(codexObservedMcpStatus({})).toBe("unknown");
    // Live 0.160.1 lists servers without startupStatus; tools prove the connection.
    expect(codexObservedMcpStatus({ authStatus: "unsupported", hasTools: true })).toBe("connected");
  });
});
