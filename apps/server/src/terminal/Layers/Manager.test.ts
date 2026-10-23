import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  DEFAULT_TERMINAL_ID,
  type TerminalEvent,
  type TerminalOpenInput,
  type TerminalRestartInput,
} from "@t3tools/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as processTree from "@t3tools/shared/processTree";
import { fallbackDefaultProfile } from "@t3tools/shared/profileIdentity";
import { projectScriptRuntimeEnv } from "@t3tools/shared/projectScripts";

import {
  PtySpawnError,
  PtyAdapter,
  type PtyAdapterShape,
  type PtyExitEvent,
  type PtyProcess,
  type PtySpawnInput,
} from "../Services/PTY";
import { TerminalManager } from "../Services/Manager";
import { TERMINAL_HISTORY_MAX_BYTES } from "../BoundedTerminalHistory";
import { TerminalManagerLive, TerminalManagerRuntime } from "./Manager";
import { Effect, Encoding, Layer, Metric } from "effect";
import { ServerConfig, type ServerConfigShape } from "../../config";

class FakePtyProcess implements PtyProcess {
  readonly writes: string[] = [];
  readonly resizeCalls: Array<{ cols: number; rows: number }> = [];
  readonly killSignals: Array<string | undefined> = [];
  private readonly dataListeners = new Set<(data: string) => void>();
  private readonly exitListeners = new Set<(event: PtyExitEvent) => void>();
  killed = false;
  exitOnKill = true;

  constructor(readonly pid: number) {}

  write(data: string): void {
    this.writes.push(data);
  }

  resize(cols: number, rows: number): void {
    this.resizeCalls.push({ cols, rows });
  }

  kill(signal?: string): void {
    this.killed = true;
    this.killSignals.push(signal);
    if (this.exitOnKill) this.emitExit({ exitCode: 0, signal: null });
  }

  onData(callback: (data: string) => void): () => void {
    this.dataListeners.add(callback);
    return () => {
      this.dataListeners.delete(callback);
    };
  }

  onExit(callback: (event: PtyExitEvent) => void): () => void {
    this.exitListeners.add(callback);
    return () => {
      this.exitListeners.delete(callback);
    };
  }

  emitData(data: string): void {
    for (const listener of this.dataListeners) {
      listener(data);
    }
  }

  emitExit(event: PtyExitEvent): void {
    for (const listener of this.exitListeners) {
      listener(event);
    }
  }
}

class FakePtyAdapter implements PtyAdapterShape {
  readonly spawnInputs: PtySpawnInput[] = [];
  readonly processes: FakePtyProcess[] = [];
  readonly spawnFailures: Error[] = [];
  nextPid = 9000;

  constructor(private readonly mode: "sync" | "async" = "sync") {}

  spawn(input: PtySpawnInput): Effect.Effect<PtyProcess, PtySpawnError> {
    this.spawnInputs.push(input);
    const failure = this.spawnFailures.shift();
    if (failure) {
      return Effect.fail(
        new PtySpawnError({
          adapter: "fake",
          message: "Failed to spawn PTY process",
          reason: (failure as NodeJS.ErrnoException).code === "ENOENT" ? "notFound" : "unknown",
          cause: failure,
        }),
      );
    }
    const process = new FakePtyProcess(this.nextPid++);
    this.processes.push(process);
    if (this.mode === "async") {
      return Effect.tryPromise({
        try: async () => process,
        catch: (cause) =>
          new PtySpawnError({
            adapter: "fake",
            message: "Failed to spawn PTY process",
            reason: "unknown",
            cause,
          }),
      });
    }
    return Effect.succeed(process);
  }
}

function waitFor(predicate: () => boolean, timeoutMs = 800): Promise<void> {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const poll = () => {
      if (predicate()) {
        resolve();
        return;
      }
      if (Date.now() - started > timeoutMs) {
        reject(new Error("Timed out waiting for condition"));
        return;
      }
      setTimeout(poll, 15);
    };
    poll();
  });
}

function openInput(overrides: Partial<TerminalOpenInput> = {}): TerminalOpenInput {
  return {
    threadId: "thread-1",
    cwd: process.cwd(),
    cols: 100,
    rows: 24,
    ...overrides,
  };
}

function restartInput(overrides: Partial<TerminalRestartInput> = {}): TerminalRestartInput {
  return {
    threadId: "thread-1",
    cwd: process.cwd(),
    cols: 100,
    rows: 24,
    ...overrides,
  };
}

function historyLogName(threadId: string): string {
  return `terminal_${Encoding.encodeBase64Url(threadId)}.log`;
}

function multiTerminalHistoryLogName(threadId: string, terminalId: string): string {
  const threadPart = `terminal_${Encoding.encodeBase64Url(threadId)}`;
  if (terminalId === DEFAULT_TERMINAL_ID) {
    return `${threadPart}.log`;
  }
  return `${threadPart}_${Encoding.encodeBase64Url(terminalId)}.log`;
}

function historyLogPath(logsDir: string, threadId = "thread-1"): string {
  return path.join(logsDir, historyLogName(threadId));
}

function multiTerminalHistoryLogPath(
  logsDir: string,
  threadId = "thread-1",
  terminalId = "default",
): string {
  return path.join(logsDir, multiTerminalHistoryLogName(threadId, terminalId));
}

function counterValue(
  snapshots: ReadonlyArray<Metric.Metric.Snapshot>,
  id: string,
  attributes: Readonly<Record<string, string>>,
): number {
  const snapshot = snapshots.find(
    (entry) =>
      entry.id === id &&
      entry.type === "Counter" &&
      Object.entries(attributes).every(([key, value]) => entry.attributes?.[key] === value),
  );
  return snapshot?.type === "Counter" ? Number(snapshot.state.count) : 0;
}

function makeServerConfig(logsDir: string): ServerConfigShape {
  const stateDir = path.dirname(logsDir);
  const providerLogsDir = path.join(logsDir, "provider");
  return {
    mode: "web",
    port: 0,
    host: undefined,
    cwd: process.cwd(),
    baseDir: path.dirname(stateDir),
    stateDir,
    dbPath: path.join(stateDir, "state.sqlite"),
    keybindingsConfigPath: path.join(stateDir, "keybindings.json"),
    worktreesDir: path.join(path.dirname(stateDir), "worktrees"),
    attachmentsDir: path.join(stateDir, "attachments"),
    logsDir,
    serverLogPath: path.join(logsDir, "server.log"),
    providerLogsDir,
    providerEventLogPath: path.join(providerLogsDir, "events.log"),
    terminalLogsDir: logsDir,
    anonymousIdPath: path.join(stateDir, "anonymous-id"),
    staticDir: undefined,
    devUrl: undefined,
    noBrowser: true,
    authToken: undefined,
    autoBootstrapProjectFromCwd: false,
    logWebSocketEvents: false,
    observabilityEnabled: false,
    acpHardeningEnabled: false,
  };
}

describe("TerminalManager", () => {
  const tempDirs: string[] = [];

  beforeEach(() => {
    // Fake PTY PIDs must never reach the host's process-tree killer.
    vi.spyOn(processTree, "killProcessTreeAsync").mockImplementation(async (child, options) => {
      child.kill(options.signal ?? (options.graceful === false ? "SIGKILL" : "SIGTERM"));
      return { terminated: true, usedFallback: false };
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    for (const dir of tempDirs.splice(0, tempDirs.length)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  function makeManager(
    historyLineLimit = 5,
    options: {
      shellResolver?: () => string;
      subprocessPollIntervalMs?: number;
      processTableReader?: () => Promise<ReadonlySet<number>>;
      processKillGraceMs?: number;
      maxRetainedInactiveSessions?: number;
      ptyAdapter?: FakePtyAdapter;
      writeHistory?: (filePath: string, history: string) => Promise<void>;
    } = {},
  ) {
    const logsDir = fs.mkdtempSync(path.join(os.tmpdir(), "t3code-terminal-"));
    tempDirs.push(logsDir);
    const ptyAdapter = options.ptyAdapter ?? new FakePtyAdapter();
    const manager = new TerminalManagerRuntime({
      logsDir,
      ptyAdapter,
      ...(options.writeHistory ? { writeHistory: options.writeHistory } : {}),
      // Fake PTY PIDs must not query or match real processes on the test host.
      processTableReader: options.processTableReader ?? (async () => new Set()),
      historyLineLimit,
      shellResolver: options.shellResolver ?? (() => "/bin/bash"),
      ...(options.subprocessPollIntervalMs
        ? { subprocessPollIntervalMs: options.subprocessPollIntervalMs }
        : {}),
      ...(options.processKillGraceMs ? { processKillGraceMs: options.processKillGraceMs } : {}),
      ...(options.maxRetainedInactiveSessions
        ? { maxRetainedInactiveSessions: options.maxRetainedInactiveSessions }
        : {}),
    });
    return { logsDir, ptyAdapter, manager };
  }

  it("closes only freshly verified idle terminals and retains their history", async () => {
    const { manager, ptyAdapter } = makeManager(5, {
      processTableReader: async () => new Set([9001]),
    });
    try {
      await manager.open(openInput());
      ptyAdapter.processes[0]!.emitData("kept history\n");
      await manager.open({ ...openInput(), terminalId: "busy" });
      await manager.closeIdleForThread("thread-1");
      expect(ptyAdapter.processes[0]!.killed).toBe(true);
      expect(ptyAdapter.processes[1]!.killed).toBe(false);
      expect(manager.listSessions().map((session) => session.terminalId)).toEqual(["busy"]);
      expect((await manager.open(openInput())).history).toContain("kept history");
    } finally {
      manager.dispose();
    }
  });

  it("preserves a terminal that receives input while its idle probe is in flight", async () => {
    let hold = false;
    let release: ((parents: ReadonlySet<number>) => void) | undefined;
    const { manager, ptyAdapter } = makeManager(5, {
      subprocessPollIntervalMs: 100_000,
      processTableReader: () =>
        hold
          ? new Promise<ReadonlySet<number>>((resolve) => {
              release = resolve;
            })
          : Promise.resolve(new Set()),
    });
    try {
      await manager.open(openInput());
      hold = true;
      const closing = manager.closeIdleForThread("thread-1");
      await vi.waitFor(() => expect(release).toBeDefined());
      await manager.write({ threadId: "thread-1", data: "new work\n" });
      release!(new Set());
      await closing;
      expect(ptyAdapter.processes[0]!.killed).toBe(false);
      expect(manager.listSessions()).toHaveLength(1);
    } finally {
      manager.dispose();
    }
  });

  it("retains terminals when the fresh idle probe fails", async () => {
    let fail = false;
    const { manager, ptyAdapter } = makeManager(5, {
      processTableReader: async () => {
        if (fail) throw new Error("Unavailable");
        return new Set();
      },
    });
    try {
      await manager.open(openInput());
      fail = true;
      await expect(manager.closeIdleForThread("thread-1")).rejects.toThrow("Unavailable");
      expect(ptyAdapter.processes[0]!.killed).toBe(false);
      expect(manager.listSessions()).toHaveLength(1);
    } finally {
      manager.dispose();
    }
  });

  it("captures monotonic read-only snapshots across output, clear, resize, restart and backend replacement", async () => {
    const { manager, ptyAdapter } = makeManager();
    const events: TerminalEvent[] = [];
    manager.on("event", (event) => events.push(event));
    expect(manager.readSnapshot({ threadId: "thread-1" })).toBeNull();
    expect(ptyAdapter.spawnInputs).toHaveLength(0);
    const first = await manager.open(openInput());
    ptyAdapter.processes[0]!.emitData("before clear\n");
    const before = manager.readSnapshot({ threadId: "thread-1" })!;
    await manager.clear({ threadId: "thread-1" });
    const cleared = manager.readSnapshot({ threadId: "thread-1" })!;
    expect(cleared.history).toBe("");
    expect(cleared.revision).toBeGreaterThan(before.revision);
    await manager.resize({ threadId: "thread-1", cols: 80, rows: 24 });
    expect(manager.readSnapshot({ threadId: "thread-1" })!.revision).toBeGreaterThan(
      cleared.revision,
    );
    const restarted = await manager.restart(restartInput());
    expect(restarted.epoch).toBe(first.epoch);
    expect(restarted.generation).toBeGreaterThan(first.generation);
    expect(events.map((event) => event.revision)).toEqual(events.map((_, index) => index + 1));
    const other = makeManager().manager;
    const otherSnapshot = await other.open(openInput());
    expect(otherSnapshot.epoch).not.toBe(first.epoch);
    await manager.dispose();
    await other.dispose();
  });

  it("reclaims closed revision state and gives a reopened key a newer generation", async () => {
    const { manager } = makeManager();
    const first = await manager.open(openInput());
    await manager.close({ threadId: first.threadId, terminalId: first.terminalId });
    expect(manager.readSnapshot({ threadId: first.threadId })).toBeNull();
    const reopened = await manager.open(openInput());
    expect(reopened.epoch).toBe(first.epoch);
    expect(reopened.generation).toBeGreaterThan(first.generation);
    await manager.dispose();
  });

  it("spawns lazily and reuses running terminal per thread", async () => {
    const { manager, ptyAdapter } = makeManager();
    const [first, second] = await Promise.all([
      manager.open(openInput()),
      manager.open(openInput()),
    ]);
    const third = await manager.open(openInput());

    expect(first.threadId).toBe("thread-1");
    expect(first.terminalId).toBe("default");
    expect(second.threadId).toBe("thread-1");
    expect(third.threadId).toBe("thread-1");
    expect(ptyAdapter.spawnInputs).toHaveLength(1);

    await manager.dispose();
  });

  it.each([undefined, "", "24bit"])(
    "advertises truecolor while preserving overrides (%s)",
    async (color) => {
      const { manager, ptyAdapter } = makeManager();
      try {
        await manager.open({ ...openInput(), env: { COLORTERM: color ?? "" } });
        expect(ptyAdapter.spawnInputs[0]?.env.COLORTERM).toBe(color || "truecolor");
      } finally {
        await manager.dispose();
      }
    },
  );

  it("supports asynchronous PTY spawn effects", async () => {
    const { manager, ptyAdapter } = makeManager(5, { ptyAdapter: new FakePtyAdapter("async") });

    const snapshot = await manager.open(openInput());

    expect(snapshot.status).toBe("running");
    expect(ptyAdapter.spawnInputs).toHaveLength(1);
    expect(ptyAdapter.processes).toHaveLength(1);

    await manager.dispose();
  });

  it("records observability metrics for open and restart", async () => {
    const logsDir = fs.mkdtempSync(path.join(os.tmpdir(), "t3code-terminal-service-"));
    tempDirs.push(logsDir);
    const ptyAdapter = new FakePtyAdapter();
    const layer = TerminalManagerLive.pipe(
      Layer.provide(Layer.succeed(PtyAdapter, ptyAdapter satisfies PtyAdapterShape)),
      Layer.provide(Layer.succeed(ServerConfig, makeServerConfig(logsDir))),
    );

    await Effect.runPromise(
      Effect.gen(function* () {
        const before = yield* Metric.snapshot;
        const manager = yield* TerminalManager;
        yield* manager.open(openInput());
        yield* manager.restart(restartInput());
        const after = yield* Metric.snapshot;

        expect(
          counterValue(after, "t3_terminal_sessions_total", {
            lifecycle: "started",
          }) -
            counterValue(before, "t3_terminal_sessions_total", {
              lifecycle: "started",
            }),
        ).toBeGreaterThanOrEqual(1);
        expect(
          counterValue(after, "t3_terminal_sessions_total", {
            lifecycle: "restarted",
          }) -
            counterValue(before, "t3_terminal_sessions_total", {
              lifecycle: "restarted",
            }),
        ).toBeGreaterThanOrEqual(1);
        expect(
          counterValue(after, "t3_terminal_restarts_total", {
            scope: "thread",
          }) -
            counterValue(before, "t3_terminal_restarts_total", {
              scope: "thread",
            }),
        ).toBeGreaterThanOrEqual(1);
      }).pipe(Effect.provide(layer), Effect.scoped),
    );
  });

  it("forwards write and resize to active pty process", async () => {
    const { manager, ptyAdapter } = makeManager();
    await manager.open(openInput());
    const process = ptyAdapter.processes[0];
    expect(process).toBeDefined();
    if (!process) return;

    await manager.write({ threadId: "thread-1", data: "ls\n" });
    await manager.resize({ threadId: "thread-1", cols: 120, rows: 30 });

    expect(process.writes).toEqual(["ls\n"]);
    expect(process.resizeCalls).toEqual([{ cols: 120, rows: 30 }]);

    await manager.dispose();
  });

  it("resizes running terminal on open when a different size is requested", async () => {
    const { manager, ptyAdapter } = makeManager();
    await manager.open(openInput({ cols: 100, rows: 24 }));
    const process = ptyAdapter.processes[0];
    expect(process).toBeDefined();
    if (!process) return;

    await manager.open(openInput({ cols: 140, rows: 40 }));

    expect(process.resizeCalls).toEqual([{ cols: 140, rows: 40 }]);

    await manager.dispose();
  });

  it("preserves existing terminal size on open when size is omitted", async () => {
    const { manager, ptyAdapter } = makeManager();
    await manager.open(openInput({ cols: 100, rows: 24 }));
    const ptyProcess = ptyAdapter.processes[0];
    expect(ptyProcess).toBeDefined();
    if (!ptyProcess) return;

    await manager.open({
      threadId: "thread-1",
      cwd: globalThis.process.cwd(),
    });

    expect(ptyProcess.resizeCalls).toEqual([]);

    ptyProcess.emitExit({ exitCode: 0, signal: 0 });
    await manager.open({
      threadId: "thread-1",
      cwd: globalThis.process.cwd(),
    });

    const resumedSpawn = ptyAdapter.spawnInputs[1];
    expect(resumedSpawn).toBeDefined();
    if (!resumedSpawn) return;
    expect(resumedSpawn.cols).toBe(100);
    expect(resumedSpawn.rows).toBe(24);

    await manager.dispose();
  });

  it("uses default dimensions when opening a new terminal without size hints", async () => {
    const { manager, ptyAdapter } = makeManager();
    await manager.open({
      threadId: "thread-1",
      cwd: process.cwd(),
    });

    const spawned = ptyAdapter.spawnInputs[0];
    expect(spawned).toBeDefined();
    if (!spawned) return;
    expect(spawned.cols).toBe(120);
    expect(spawned.rows).toBe(30);

    await manager.dispose();
  });

  it("supports multiple terminals per thread with isolated sessions", async () => {
    const { manager, ptyAdapter } = makeManager();
    await manager.open(openInput({ terminalId: "default" }));
    await manager.open(openInput({ terminalId: "term-2" }));

    const first = ptyAdapter.processes[0];
    const second = ptyAdapter.processes[1];
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    if (!first || !second) return;

    await manager.write({ threadId: "thread-1", terminalId: "default", data: "pwd\n" });
    await manager.write({ threadId: "thread-1", terminalId: "term-2", data: "ls\n" });

    expect(first.writes).toEqual(["pwd\n"]);
    expect(second.writes).toEqual(["ls\n"]);
    expect(ptyAdapter.spawnInputs).toHaveLength(2);

    await manager.dispose();
  });

  it("clears transcript and emits cleared event", async () => {
    const { manager, ptyAdapter, logsDir } = makeManager();
    const events: TerminalEvent[] = [];
    manager.on("event", (event) => {
      events.push(event);
    });
    await manager.open(openInput());
    const process = ptyAdapter.processes[0];
    expect(process).toBeDefined();
    if (!process) return;

    process.emitData("hello\n");
    await waitFor(() => fs.existsSync(historyLogPath(logsDir)));
    await manager.clear({ threadId: "thread-1" });
    await waitFor(() => fs.readFileSync(historyLogPath(logsDir), "utf8") === "");

    expect(events.some((event) => event.type === "cleared")).toBe(true);
    expect(
      events.some(
        (event) =>
          event.type === "cleared" &&
          event.threadId === "thread-1" &&
          event.terminalId === "default",
      ),
    ).toBe(true);

    await manager.dispose();
  });

  it.each(["restart", "cwd", "shutdown"] as const)(
    "drains an intentional %s without emitting a tab-closing exit",
    async (operation) => {
      const { manager, ptyAdapter, logsDir } = makeManager();
      const events: TerminalEvent[] = [];
      manager.on("event", (event) => events.push(event));
      await manager.open(openInput());
      const source = ptyAdapter.processes[0]!;
      source.exitOnKill = false;
      const stopping =
        operation === "restart"
          ? manager.restart(restartInput())
          : operation === "cwd"
            ? manager.open(openInput({ cwd: logsDir }))
            : manager.dispose();
      await waitFor(() => source.killSignals.length > 0);
      source.emitData("last graceful output\n");
      source.emitExit({ exitCode: 0, signal: 15 });
      await stopping;
      expect(events.map((event) => event.type)).toEqual(
        operation === "shutdown"
          ? ["started", "output"]
          : ["started", "output", "cleared", operation === "restart" ? "restarted" : "started"],
      );
      if (operation === "shutdown")
        expect(fs.readFileSync(historyLogPath(logsDir), "utf8")).toContain("last graceful output");
      else {
        ptyAdapter.processes[1]!.emitExit({ exitCode: 1, signal: null });
        expect(events.at(-1)?.type).toBe("exited");
      }
      await manager.dispose();
    },
  );

  it("restarts terminal with empty transcript and respawns pty", async () => {
    const { manager, ptyAdapter, logsDir } = makeManager();
    await manager.open(openInput());
    const firstProcess = ptyAdapter.processes[0];
    expect(firstProcess).toBeDefined();
    if (!firstProcess) return;
    firstProcess.emitData("before restart\n");
    await waitFor(() => fs.existsSync(historyLogPath(logsDir)));

    const snapshot = await manager.restart(restartInput());
    expect(snapshot.history).toBe("");
    expect(snapshot.status).toBe("running");
    expect(ptyAdapter.spawnInputs).toHaveLength(2);
    await waitFor(() => fs.readFileSync(historyLogPath(logsDir), "utf8") === "");

    await manager.dispose();
  });

  it("emits exited event and reopens with clean transcript after exit", async () => {
    const { manager, ptyAdapter, logsDir } = makeManager();
    const events: TerminalEvent[] = [];
    manager.on("event", (event) => {
      events.push(event);
    });
    await manager.open(openInput());
    const process = ptyAdapter.processes[0];
    expect(process).toBeDefined();
    if (!process) return;
    process.emitData("old data\n");
    await waitFor(() => fs.existsSync(historyLogPath(logsDir)));
    process.emitExit({ exitCode: 0, signal: 0 });

    await waitFor(() => events.some((event) => event.type === "exited"));
    const reopened = await manager.open(openInput());

    expect(reopened.history).toBe("");
    expect(ptyAdapter.spawnInputs).toHaveLength(2);
    expect(fs.readFileSync(historyLogPath(logsDir), "utf8")).toBe("");

    await manager.dispose();
  });

  it("ignores trailing writes after terminal exit", async () => {
    const { manager, ptyAdapter } = makeManager();
    await manager.open(openInput());
    const process = ptyAdapter.processes[0];
    expect(process).toBeDefined();
    if (!process) return;

    process.emitExit({ exitCode: 0, signal: 0 });

    await expect(manager.write({ threadId: "thread-1", data: "\r" })).resolves.toBeUndefined();
    expect(process.writes).toEqual([]);

    await manager.dispose();
  });

  it("emits subprocess activity events when child-process state changes", async () => {
    let hasRunningSubprocess = false;
    const { manager } = makeManager(5, {
      processTableReader: async () => new Set(hasRunningSubprocess ? [9000] : []),
      subprocessPollIntervalMs: 20,
    });
    const events: TerminalEvent[] = [];
    manager.on("event", (event) => {
      events.push(event);
    });

    await manager.open(openInput());
    await waitFor(() => events.some((event) => event.type === "started"));
    expect(events.some((event) => event.type === "activity")).toBe(false);

    hasRunningSubprocess = true;
    await waitFor(
      () =>
        events.some((event) => event.type === "activity" && event.hasRunningSubprocess === true),
      1_200,
    );

    hasRunningSubprocess = false;
    await waitFor(
      () =>
        events.some((event) => event.type === "activity" && event.hasRunningSubprocess === false),
      1_200,
    );

    await manager.dispose();
  });

  it("shares one process table per poll and preserves activity after failed reads", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const reader = vi.fn(async () => new Set(Array.from({ length: 20 }, (_, i) => 9000 + i)));
    const { manager } = makeManager(5, { processTableReader: reader });
    const events: TerminalEvent[] = [];
    manager.on("event", (event) => events.push(event));
    try {
      for (let i = 0; i < 20; i++) await manager.open({ ...openInput(), threadId: `poll-${i}` });
      await waitFor(() => reader.mock.calls.length === 1);
      reader.mockClear();
      await vi.advanceTimersByTimeAsync(1999);
      expect(reader).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(reader).toHaveBeenCalledOnce();
      expect(
        events.filter((event) => event.type === "activity" && event.hasRunningSubprocess),
      ).toHaveLength(20);
      events.length = 0;
      const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
      const info = vi.spyOn(console, "log").mockImplementation(() => {});
      reader.mockRejectedValue(new Error("snapshot unavailable"));
      await vi.advanceTimersByTimeAsync(6000);
      expect(warning).toHaveBeenCalledTimes(1);
      expect(events.filter((event) => event.type === "activity")).toHaveLength(0);
      reader.mockResolvedValue(new Set());
      await vi.advanceTimersByTimeAsync(2000);
      expect(
        events.filter((event) => event.type === "activity" && !event.hasRunningSubprocess),
      ).toHaveLength(20);
      expect(info).toHaveBeenCalledWith(expect.stringContaining("reads recovered"));
      reader.mockRejectedValue(new Error("failed again"));
      await vi.advanceTimersByTimeAsync(2000);
      expect(warning).toHaveBeenCalledTimes(2);
      warning.mockRestore();
      info.mockRestore();
    } finally {
      await manager.dispose();
      vi.useRealTimers();
    }
  });

  it("bounds retained and persisted output while delivering every live byte", async () => {
    const { manager, ptyAdapter, logsDir } = makeManager(5000);
    const events: TerminalEvent[] = [];
    manager.on("event", (event) => events.push(event));
    try {
      await manager.open(openInput());
      const data = "🙂".repeat(TERMINAL_HISTORY_MAX_BYTES / 4 + 200);
      ptyAdapter.processes[0]!.emitData(data);
      expect(
        events
          .filter((event) => event.type === "output")
          .map((event) => event.data)
          .join(""),
      ).toBe(data);
      const attached = await manager.open(openInput());
      expect(Buffer.byteLength(attached.history)).toBe(TERMINAL_HISTORY_MAX_BYTES);
      await manager.close({ threadId: "thread-1" });
      expect(fs.statSync(historyLogPath(logsDir)).size).toBe(TERMINAL_HISTORY_MAX_BYTES);
      expect((await manager.open(openInput())).history).toBe(attached.history);
      await manager.clear({ threadId: "thread-1" });
      ptyAdapter.processes.at(-1)!.emitData("\ud83d");
      ptyAdapter.processes.at(-1)!.emitData("\ude42\r\n");
      await manager.close({ threadId: "thread-1" });
      expect((await manager.open(openInput())).history).toBe("🙂\r\n");
    } finally {
      await manager.dispose();
    }
  });

  it("coalesces output while a persistence write is blocked", async () => {
    const release = Promise.withResolvers<void>();
    const write = vi.fn(async (filePath: string, history: string) => {
      if (write.mock.calls.length === 1) await release.promise;
      await fs.promises.writeFile(filePath, history, "utf8");
    });
    const { manager, ptyAdapter, logsDir } = makeManager(5000, { writeHistory: write });
    try {
      await manager.open(openInput());
      ptyAdapter.processes[0]!.emitData("first\n");
      await waitFor(() => write.mock.calls.length === 1);
      for (let i = 0; i < 50; i++) ptyAdapter.processes[0]!.emitData(`${i}\n`);
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(write).toHaveBeenCalledTimes(1);
      release.resolve();
      await manager.close({ threadId: "thread-1" });
      expect(write).toHaveBeenCalledTimes(2);
      expect(fs.readFileSync(historyLogPath(logsDir), "utf8")).toBe(
        "first\n" + Array.from({ length: 50 }, (_, i) => `${i}\n`).join(""),
      );
    } finally {
      release.resolve();
      await manager.dispose();
    }
  });

  it("persists output emitted during TERM and makes disposal idempotent", async () => {
    const { manager, ptyAdapter, logsDir } = makeManager();
    await manager.open(openInput());
    const source = ptyAdapter.processes[0]!;
    source.emitData("before\n");
    vi.spyOn(source, "kill").mockImplementation(() => {
      source.emitData("final🙂");
      source.emitExit({ exitCode: 0, signal: null });
    });
    const first = manager.dispose();
    expect(manager.dispose()).toBe(first);
    await first;
    expect(fs.readFileSync(historyLogPath(logsDir), "utf8")).toBe("before\nfinal🙂");
    await expect(manager.open(openInput())).rejects.toThrow("shutting down");
    expect(manager.listenerCount("event")).toBe(0);
  });

  it("flushes the final source bytes before closing and reopening a terminal", async () => {
    const { manager, ptyAdapter, logsDir } = makeManager();
    try {
      await manager.open(openInput());
      const source = ptyAdapter.processes[0]!;
      source.emitData("before\n");
      vi.spyOn(source, "kill").mockImplementation(() => {
        source.emitData("final🙂");
        source.emitExit({ exitCode: 0, signal: null });
      });
      await manager.close({ threadId: "thread-1" });
      expect(fs.readFileSync(historyLogPath(logsDir), "utf8")).toBe("before\nfinal🙂");
      const reopened = await manager.open(openInput());
      expect(reopened.history).toBe("before\nfinal🙂");
    } finally {
      await manager.dispose();
    }
  });

  it("waits for the old terminal source before changing directories and fences late old output", async () => {
    const logsDir = fs.mkdtempSync(path.join(os.tmpdir(), "f5-terminal-directory-"));
    tempDirs.push(logsDir);
    const adapter = new FakePtyAdapter();
    const manager = new TerminalManagerRuntime({
      logsDir,
      ptyAdapter: adapter,
      shellResolver: () => process.execPath,
    });
    const input = openInput();
    await manager.open(input);
    const old = adapter.processes[0]!;
    old.exitOnKill = false;
    const next = manager.open({ ...input, cwd: logsDir });
    await vi.waitFor(() =>
      expect(old.killSignals).toContain(process.platform === "win32" ? "SIGKILL" : "SIGTERM"),
    );
    expect(adapter.processes).toHaveLength(1);
    old.emitData("last old output");
    old.emitExit({ exitCode: 0, signal: null });
    const opened = await next;
    expect(adapter.processes).toHaveLength(2);
    expect(opened.status).toBe("running");
    old.emitData("late old output");
    old.emitExit({ exitCode: 0, signal: null });
    adapter.processes[1]!.emitData("current output");
    const current = await manager.open({ ...input, cwd: logsDir });
    expect(current.status).toBe("running");
    expect(current.history).toBe("current output");
    await manager.dispose();
  });

  it("shares one source stop when close and shutdown overlap", async () => {
    const logsDir = fs.mkdtempSync(path.join(os.tmpdir(), "f5-terminal-shared-stop-"));
    tempDirs.push(logsDir);
    const adapter = new FakePtyAdapter();
    const manager = new TerminalManagerRuntime({
      logsDir,
      ptyAdapter: adapter,
      shellResolver: () => process.execPath,
    });
    const input = openInput();
    await manager.open(input);
    const source = adapter.processes[0]!;
    source.exitOnKill = false;
    const close = manager.close({ threadId: input.threadId, terminalId: input.terminalId });
    await vi.waitFor(() =>
      expect(source.killSignals).toContain(process.platform === "win32" ? "SIGKILL" : "SIGTERM"),
    );
    const signalsBeforeDisposal = [...source.killSignals];
    const disposal = manager.dispose();
    source.emitData("last output");
    source.emitExit({ exitCode: 0, signal: null });
    await Promise.all([close, disposal]);
    expect(source.killSignals).toEqual(signalsBeforeDisposal);
  });

  it("does not rewrite unchanged histories on repeated close, reopen and shutdown", async () => {
    const write = vi.fn(async (filePath: string, history: string) => {
      await fs.promises.writeFile(filePath, history, "utf8");
    });
    const { manager, ptyAdapter } = makeManager(5000, { writeHistory: write });
    try {
      await manager.open(openInput());
      ptyAdapter.processes[0]!.emitData("persist once\n");
      await manager.close({ threadId: "thread-1" });
      expect(write).toHaveBeenCalledTimes(1);
      await manager.open(openInput());
      await manager.close({ threadId: "thread-1" });
      expect(write).toHaveBeenCalledTimes(1);
      await manager.open(openInput());
      await manager.dispose();
      expect(write).toHaveBeenCalledTimes(1);
    } finally {
      await manager.dispose();
    }
  });

  it("batches live history writes every 250 ms and flushes the latest output on close", async () => {
    const writes: string[] = [];
    const { manager, ptyAdapter, logsDir } = makeManager(5000, {
      writeHistory: async (filePath: string, history: string) => {
        writes.push(history);
        await fs.promises.writeFile(filePath, history, "utf8");
      },
    });
    try {
      await manager.open(openInput());
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      ptyAdapter.processes[0]!.emitData("first");
      await vi.advanceTimersByTimeAsync(200);
      expect(writes).toEqual([]);
      ptyAdapter.processes[0]!.emitData(" second");
      await vi.advanceTimersByTimeAsync(50);
      vi.useRealTimers();
      await waitFor(() => writes.length === 1);
      expect(writes).toEqual(["first second"]);
      ptyAdapter.processes[0]!.emitData(" third");
      await manager.close({ threadId: "thread-1" });
      expect(fs.readFileSync(historyLogPath(logsDir), "utf8")).toBe("first second third");
    } finally {
      vi.useRealTimers();
      await manager.dispose();
    }
  });

  it("retains a dirty snapshot after a failed write and repairs it during final flush", async () => {
    const write = vi.fn(async (filePath: string, history: string) => {
      if (write.mock.calls.length === 1) throw new Error("disk temporarily unavailable");
      await fs.promises.writeFile(filePath, history, "utf8");
    });
    const { manager, ptyAdapter, logsDir } = makeManager(5000, { writeHistory: write });
    await manager.open(openInput());
    ptyAdapter.processes[0]!.emitData("must survive");
    await manager.dispose();
    expect(fs.readFileSync(historyLogPath(logsDir), "utf8")).toBe("must survive");
    expect(write).toHaveBeenCalledTimes(2);
  });

  it("bounds shutdown when a PTY never closes and still flushes history", async () => {
    const { manager, ptyAdapter, logsDir } = makeManager(5, { processKillGraceMs: 1 });
    await manager.open(openInput());
    const source = ptyAdapter.processes[0]!;
    source.exitOnKill = false;
    source.emitData("last bytes");
    await manager.dispose(Date.now() + 100);
    expect(source.killSignals).toContain("SIGKILL");
    expect(fs.readFileSync(historyLogPath(logsDir), "utf8")).toBe("last bytes");
  });

  it.each(["restart", "replace with reused PID"] as const)(
    "ignores a process-table result after %s",
    async (operation) => {
      const pending = Promise.withResolvers<ReadonlySet<number>>();
      const reader = vi.fn(() => pending.promise);
      const { manager, ptyAdapter } = makeManager(5, { processTableReader: reader });
      const events: TerminalEvent[] = [];
      manager.on("event", (event) => events.push(event));
      try {
        await manager.open(openInput());
        expect(reader).toHaveBeenCalledOnce();
        if (operation === "restart") {
          await manager.restart({ ...openInput(), cols: 120, rows: 30 });
        } else {
          await manager.close({ threadId: "thread-1" });
          ptyAdapter.nextPid = 9000;
          expect((await manager.open(openInput())).pid).toBe(9000);
        }
        events.length = 0;
        pending.resolve(new Set([9000, 9001]));
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(events.filter((event) => event.type === "activity")).toHaveLength(0);
      } finally {
        pending.resolve(new Set());
        await manager.dispose();
      }
    },
  );

  it("caps persisted history to configured line limit", async () => {
    const { manager, ptyAdapter } = makeManager(3);
    await manager.open(openInput());
    const process = ptyAdapter.processes[0];
    expect(process).toBeDefined();
    if (!process) return;

    process.emitData("line1\nline2\nline3\nline4\n");
    await manager.close({ threadId: "thread-1" });

    const reopened = await manager.open(openInput());
    const nonEmptyLines = reopened.history.split("\n").filter((line) => line.length > 0);
    expect(nonEmptyLines).toEqual(["line2", "line3", "line4"]);

    await manager.dispose();
  });

  it("deletes history file when close(deleteHistory=true)", async () => {
    const { manager, ptyAdapter, logsDir } = makeManager();
    await manager.open(openInput());
    const process = ptyAdapter.processes[0];
    expect(process).toBeDefined();
    if (!process) return;
    process.emitData("bye\n");
    await waitFor(() => fs.existsSync(historyLogPath(logsDir)));

    await manager.close({ threadId: "thread-1", deleteHistory: true });
    expect(fs.existsSync(historyLogPath(logsDir))).toBe(false);

    await manager.dispose();
  });

  it("closes all terminals for a thread when close omits terminalId", async () => {
    const { manager, ptyAdapter, logsDir } = makeManager();
    await manager.open(openInput({ terminalId: "default" }));
    await manager.open(openInput({ terminalId: "sidecar" }));
    const defaultProcess = ptyAdapter.processes[0];
    const sidecarProcess = ptyAdapter.processes[1];
    expect(defaultProcess).toBeDefined();
    expect(sidecarProcess).toBeDefined();
    if (!defaultProcess || !sidecarProcess) return;

    defaultProcess.emitData("default\n");
    sidecarProcess.emitData("sidecar\n");
    await waitFor(() => fs.existsSync(multiTerminalHistoryLogPath(logsDir, "thread-1", "default")));
    await waitFor(() => fs.existsSync(multiTerminalHistoryLogPath(logsDir, "thread-1", "sidecar")));

    await manager.close({ threadId: "thread-1", deleteHistory: true });

    expect(defaultProcess.killed).toBe(true);
    expect(sidecarProcess.killed).toBe(true);
    expect(fs.existsSync(multiTerminalHistoryLogPath(logsDir, "thread-1", "default"))).toBe(false);
    expect(fs.existsSync(multiTerminalHistoryLogPath(logsDir, "thread-1", "sidecar"))).toBe(false);

    await manager.dispose();
  });

  it("escalates terminal shutdown to SIGKILL when process does not exit in time", async () => {
    const { manager, ptyAdapter } = makeManager(5, { processKillGraceMs: 10 });
    await manager.open(openInput());
    const process = ptyAdapter.processes[0];
    expect(process).toBeDefined();
    if (!process) return;
    process.exitOnKill = false;

    await manager.close({ threadId: "thread-1" });
    await waitFor(() => process.killSignals.includes("SIGKILL"));

    expect(process.killSignals[0]).toBe(
      globalThis.process.platform === "win32" ? "SIGKILL" : "SIGTERM",
    );
    expect(process.killSignals).toContain("SIGKILL");

    await manager.dispose();
  });

  it("evicts oldest inactive terminal sessions when retention limit is exceeded", async () => {
    const { manager, ptyAdapter } = makeManager(5, { maxRetainedInactiveSessions: 1 });

    await manager.open(openInput({ threadId: "thread-1" }));
    await manager.open(openInput({ threadId: "thread-2" }));

    const first = ptyAdapter.processes[0];
    const second = ptyAdapter.processes[1];
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    if (!first || !second) return;

    first.emitExit({ exitCode: 0, signal: 0 });
    await new Promise((resolve) => setTimeout(resolve, 5));
    second.emitExit({ exitCode: 0, signal: 0 });

    await waitFor(() => {
      const sessions = (manager as unknown as { sessions: Map<string, unknown> }).sessions;
      return sessions.size === 1;
    });

    const sessions = (manager as unknown as { sessions: Map<string, unknown> }).sessions;
    const keys = [...sessions.keys()];
    expect(keys).toEqual(["thread:thread-2\u0000default"]);

    await manager.dispose();
  });

  it("migrates legacy transcript filenames to terminal-scoped history path on open", async () => {
    const { manager, logsDir } = makeManager();
    const legacyPath = path.join(logsDir, "thread-1.log");
    const nextPath = historyLogPath(logsDir);
    fs.writeFileSync(legacyPath, "legacy-line\n", "utf8");

    const snapshot = await manager.open(openInput());

    expect(snapshot.history).toBe("legacy-line\n");
    expect(fs.existsSync(nextPath)).toBe(true);
    expect(fs.readFileSync(nextPath, "utf8")).toBe("legacy-line\n");
    expect(fs.existsSync(legacyPath)).toBe(false);

    await manager.dispose();
  });

  it("retries with fallback shells when preferred shell spawn fails", async () => {
    const { manager, ptyAdapter } = makeManager(5, {
      shellResolver: () =>
        process.platform === "win32" ? "/definitely/missing-shell" : "/definitely/missing-shell -l",
    });
    ptyAdapter.spawnFailures.push(
      Object.assign(new Error("localized missing-shell message"), { code: "ENOENT" }),
    );

    const snapshot = await manager.open(openInput());

    expect(snapshot.status).toBe("running");
    expect(ptyAdapter.spawnInputs.length).toBeGreaterThanOrEqual(2);
    expect(ptyAdapter.spawnInputs[0]?.shell).toBe("/definitely/missing-shell");

    if (process.platform === "win32") {
      expect(
        ptyAdapter.spawnInputs.some((input) =>
          ["cmd.exe", "powershell.exe", "pwsh.exe"].includes(
            path.win32.basename(input.shell).toLowerCase(),
          ),
        ),
      ).toBe(true);
    } else {
      expect(
        ptyAdapter.spawnInputs.some((input) =>
          ["/bin/zsh", "/bin/bash", "/bin/sh", "zsh", "bash", "sh"].includes(input.shell),
        ),
      ).toBe(true);
    }

    await manager.dispose();
  });

  it("filters app runtime env variables from terminal sessions", async () => {
    const originalValues = new Map<string, string | undefined>();
    const setEnv = (key: string, value: string | undefined) => {
      if (!originalValues.has(key)) {
        originalValues.set(key, process.env[key]);
      }
      if (value === undefined) {
        delete process.env[key];
        return;
      }
      process.env[key] = value;
    };
    const restoreEnv = () => {
      for (const [key, value] of originalValues) {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
    };

    setEnv("PORT", "5173");
    setEnv("T3CODE_PORT", "3773");
    setEnv("VITE_DEV_SERVER_URL", "http://localhost:5173");
    setEnv("TEST_TERMINAL_KEEP", "keep-me");

    try {
      const { manager, ptyAdapter } = makeManager();
      await manager.open(openInput());
      const spawnInput = ptyAdapter.spawnInputs[0];
      expect(spawnInput).toBeDefined();
      if (!spawnInput) return;

      expect(spawnInput.env.PORT).toBeUndefined();
      expect(spawnInput.env.T3CODE_PORT).toBeUndefined();
      expect(spawnInput.env.VITE_DEV_SERVER_URL).toBeUndefined();
      expect(spawnInput.env.TEST_TERMINAL_KEEP).toBe("keep-me");

      await manager.dispose();
    } finally {
      restoreEnv();
    }
  });

  it("injects runtime env overrides into spawned terminals", async () => {
    const { manager, ptyAdapter } = makeManager();
    await manager.open(
      openInput({
        env: {
          T3CODE_PROJECT_ROOT: "/repo",
          T3CODE_WORKTREE_PATH: "/repo/worktree-a",
          CUSTOM_FLAG: "1",
        },
      }),
    );
    const spawnInput = ptyAdapter.spawnInputs[0];
    expect(spawnInput).toBeDefined();
    if (!spawnInput) return;

    expect(spawnInput.env.T3CODE_PROJECT_ROOT).toBe("/repo");
    expect(spawnInput.env.T3CODE_WORKTREE_PATH).toBe("/repo/worktree-a");
    expect(spawnInput.env.CUSTOM_FLAG).toBe("1");

    await manager.dispose();
  });

  it.each([true, false])(
    "passes project script env to profile terminals (Default=%s)",
    async (isDefault) => {
      const logsDir = fs.mkdtempSync(path.join(os.tmpdir(), "f5-terminal-profile-"));
      tempDirs.push(logsDir);
      const config = makeServerConfig(logsDir);
      const ptyAdapter = new FakePtyAdapter();
      const manager = new TerminalManagerRuntime({
        logsDir,
        ptyAdapter,
        processTableReader: async () => new Set(),
        shellResolver: () => "/bin/bash",
        accountConfig: {
          ...config,
          profile: { ...fallbackDefaultProfile(config.stateDir), isDefault },
        },
      });
      const snapshot = await manager.open(
        openInput({
          env: projectScriptRuntimeEnv({
            project: { cwd: "/repo" },
            worktreePath: "/repo/worktree-a",
          }),
        }),
      );

      expect(snapshot.status).toBe("running");
      expect(ptyAdapter.spawnInputs[0]?.env.T3CODE_PROJECT_ROOT).toBe("/repo");
      expect(ptyAdapter.spawnInputs[0]?.env.T3CODE_WORKTREE_PATH).toBe("/repo/worktree-a");
      expect(ptyAdapter.spawnInputs[0]?.env.F5_PROFILE_ISOLATED).toBe(isDefault ? undefined : "1");

      await manager.dispose();
    },
  );

  it.skipIf(process.platform === "win32")(
    "starts zsh with prompt spacer disabled to avoid `%` end markers",
    async () => {
      const { manager, ptyAdapter } = makeManager(5, {
        shellResolver: () => "/bin/zsh",
      });
      await manager.open(openInput());
      const spawnInput = ptyAdapter.spawnInputs[0];
      expect(spawnInput).toBeDefined();
      if (!spawnInput) return;

      expect(spawnInput.shell).toBe("/bin/zsh");
      expect(spawnInput.args).toEqual(["-o", "nopromptsp"]);

      await manager.dispose();
    },
  );
});
