import { execFileSync, fork } from "node:child_process";
import { createHash } from "node:crypto";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { Effect, Layer, ManagedRuntime, Stream } from "effect";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { expect, it, vi } from "vitest";
import {
  CommandId,
  ThreadId,
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
} from "@t3tools/contracts";
import {
  prepareAttachmentIngress,
  persistPreparedAttachmentIngress,
  discardAttachmentIngress,
} from "../../src/attachmentIngress.ts";
import { ensureAttachmentSchema } from "../../src/persistence/Migrations/AttachmentSchema.ts";
import * as NodeSqlite from "../../src/persistence/NodeSqliteClient.ts";
import { ServerConfig } from "../../src/config.ts";
import { GitCoreLive } from "../../src/git/Layers/GitCore.ts";
import { GitServiceLive } from "../../src/git/Layers/GitService.ts";
import { GitCore } from "../../src/git/Services/GitCore.ts";
import { OrchestrationEventStore } from "../../src/persistence/Services/OrchestrationEventStore.ts";
import { OrchestrationEventStoreLive } from "../../src/persistence/Layers/OrchestrationEventStore.ts";
import { makeSqlitePersistenceLive } from "../../src/persistence/Layers/Sqlite.ts";
import { TerminalManagerRuntime } from "../../src/terminal/Layers/Manager.ts";
import type { PtyProcess, PtyExitEvent } from "../../src/terminal/Services/PTY.ts";
import {
  fixture,
  repositoryFile,
  terminalChunks,
} from "../../../../scripts/lib/performance/fixtures.ts";
import {
  measure,
  metadata,
  maximumObservation,
  type PerformanceReport,
} from "../../../../scripts/lib/performance/report.ts";

const root = fileURLToPath(new URL("../../../..", import.meta.url));

/** Deterministic PTY bytes; the production manager still filters, caps and persists them. */
class FixturePty implements PtyProcess {
  readonly pid = 99999999;
  private data = new Set<(data: string) => void>();
  private exits = new Set<(event: PtyExitEvent) => void>();
  write() {}
  resize() {}
  kill() {
    for (const listener of this.exits) listener({ exitCode: 0, signal: null });
  }
  onData(callback: (data: string) => void) {
    this.data.add(callback);
    return () => this.data.delete(callback);
  }
  onExit(callback: (event: PtyExitEvent) => void) {
    this.exits.add(callback);
    return () => this.exits.delete(callback);
  }
  emit(data: string) {
    for (const callback of this.data) callback(data);
  }
}

function createRepository(directory: string): void {
  const env = {
    ...process.env,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
    GIT_AUTHOR_NAME: "F5 fixture",
    GIT_COMMITTER_NAME: "F5 fixture",
    GIT_AUTHOR_EMAIL: "fixture@example.invalid",
    GIT_COMMITTER_EMAIL: "fixture@example.invalid",
    GIT_AUTHOR_DATE: fixture.epoch,
    GIT_COMMITTER_DATE: fixture.epoch,
    GIT_TERMINAL_PROMPT: "0",
    GCM_INTERACTIVE: "never",
  };
  const git = (cwd: string, args: string[]) =>
    execFileSync("git", args, { cwd, env, stdio: "pipe" });
  const init = (cwd: string) => {
    mkdirSync(cwd, { recursive: true });
    git(cwd, ["init", "-q", "-b", "main"]);
    git(cwd, ["config", "gc.auto", "0"]);
  };
  init(directory);
  for (let i = 0; i < fixture.repository.files; i++) {
    const file = repositoryFile(i);
    const target = path.join(directory, file.path);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, file.content);
  }
  git(directory, ["add", "."]);
  git(directory, ["commit", "-qm", "fixture"]);
  const remote = path.join(path.dirname(directory), "remote.git");
  git(directory, ["clone", "--no-local", "--bare", "--quiet", directory, remote]);
  git(directory, ["remote", "add", "origin", remote]);
  git(directory, ["fetch", "--quiet", "origin"]);
  git(directory, ["branch", "--set-upstream-to=origin/main"]);
  for (let i = 0; i < fixture.repository.submodules; i++)
    git(directory, [
      "-c",
      "protocol.file.allow=always",
      "submodule",
      "add",
      "--quiet",
      remote,
      `modules/sub-${i}`,
    ]);
  git(directory, ["commit", "-qam", "submodules"]);
  for (let i = 0; i < fixture.repository.nestedRepositories; i++) {
    const nested = path.join(directory, `nested/repo-${i}`);
    init(nested);
    writeFileSync(path.join(nested, "nested.txt"), "nested\n");
    git(nested, ["add", "."]);
    git(nested, ["commit", "-qm", "nested fixture"]);
  }
  // Known dirty tracked file, untracked nested repositories and real submodule entries.
  writeFileSync(path.join(directory, repositoryFile(0).path), "export const changed = true;\n");
}

it("records server component performance with deterministic workloads", async () => {
  const output = process.env.F5_PERF_REPORT;
  if (!output) throw new Error("Use bun run perf:server; F5_PERF_REPORT is required");
  const smoke = process.env.F5_PERF_SMOKE === "1";
  const method = smoke ? { ...fixture.method, warmups: 1, repetitions: 2 } : fixture.method;
  const report: PerformanceReport = {
    schemaVersion: 1,
    scope: "server-component",
    mode: smoke ? "smoke" : "measurement",
    metadata: metadata(root),
    method: { warmups: method.warmups, repetitions: method.repetitions },
    measurements: {},
    observations: [],
    notMeasured: [
      "Browser input-to-paint, warm thread switch and startup",
      "Ten concurrent streaming threads at 20 updates/s each",
      "10-minute retained memory",
      "WebSocket slow-client overflow and resync",
      "Native PTY process-table polling",
    ],
  };
  const directory = mkdtempSync(path.join(tmpdir(), "f5-performance-"));
  const processes: FixturePty[] = [];
  const terminals = new TerminalManagerRuntime({
    logsDir: path.join(directory, "terminals"),
    shellResolver: () => process.execPath,
    ptyAdapter: {
      spawn: () => {
        const pty = new FixturePty();
        processes.push(pty);
        return Effect.succeed(pty);
      },
    },
    subprocessChecker: async () => false,
  });
  const database = path.join(directory, "events.sqlite");
  const persistence = ManagedRuntime.make(
    OrchestrationEventStoreLive.pipe(
      Layer.provideMerge(makeSqlitePersistenceLive(database)),
      Layer.provide(NodeServices.layer),
    ),
  );
  const gitRuntime = ManagedRuntime.make(
    GitCoreLive.pipe(
      Layer.provide(ServerConfig.layerTest(directory, { prefix: "f5-perf-config-" })),
      Layer.provide(GitServiceLive.pipe(Layer.provide(NodeServices.layer))),
      Layer.provide(NodeServices.layer),
    ),
  );
  const uploadRuntime = ManagedRuntime.make(
    Layer.mergeAll(NodeServices.layer, NodeSqlite.layerMemory()),
  );
  const probe = new DatabaseSync(":memory:");
  const statementPrototype = Object.getPrototypeOf(probe.prepare("SELECT 1")) as StatementSync;
  const originalAll = statementPrototype.all;
  probe.close();
  let replayPageRows = 0;
  let replayPageBytes = 0;
  const readSpy = vi.spyOn(statementPrototype, "all").mockImplementation(function (
    this: StatementSync,
    ...params
  ) {
    const rows = originalAll.apply(this, params);
    if (rows[0] && "eventId" in rows[0] && "payload" in rows[0] && "sequence" in rows[0]) {
      replayPageRows = Math.max(replayPageRows, rows.length);
      replayPageBytes = Math.max(replayPageBytes, Buffer.byteLength(JSON.stringify(rows)));
    }
    return rows;
  });
  try {
    const inputs = Array.from({ length: fixture.terminal.count }, (_, i) => ({
      threadId: `perf-${i}`,
      cwd: directory,
    }));
    for (const input of inputs) await terminals.open(input);
    const chunks = terminalChunks();
    report.measurements["terminal.ingest-20"] = await measure(
      async () => {
        for (const chunk of chunks) for (const pty of processes) pty.emit(chunk);
      },
      method,
      async () => {
        // Reset outside timing; persistence is measured separately below.
        for (const input of inputs) await terminals.clear(input);
      },
    );
    let peak = 0;
    for (const input of inputs) {
      const snapshot = await terminals.open(input);
      expect(snapshot.history).toContain("café");
      peak = Math.max(peak, Buffer.byteLength(snapshot.history));
    }
    processes[0]!.emit("x".repeat(fixture.terminal.longLineBytes));
    peak = Math.max(peak, Buffer.byteLength((await terminals.open(inputs[0]!)).history));
    report.observations.push(maximumObservation("terminal.historyBytes", peak, 4 * 1024 * 1024));
    const historyDigest = (history: string) => createHash("sha256").update(history).digest("hex");
    const expectedHistories = await Promise.all(
      inputs.map(async (input) => historyDigest((await terminals.open(input)).history)),
    );
    report.measurements["terminal.persist-reconnect-20"] = await measure(async () => {
      for (const input of inputs) await terminals.close(input);
      for (const input of inputs) await terminals.open(input);
    }, method);
    const reconnectedHistories = await Promise.all(
      inputs.map(async (input) => historyDigest((await terminals.open(input)).history)),
    );
    expect(reconnectedHistories).toEqual(expectedHistories);
    // Seed real schema rows transactionally outside the measured region. Event replay
    // still performs production SQL paging and schema decoding for every event.
    await persistence.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql.withTransaction(
          Effect.gen(function* () {
            for (let i = 0; i < fixture.replay.events; i++) {
              const payload = JSON.stringify({
                projectId: `project-${i}`,
                title: `Project ${i}`,
                workspaceRoot: `/fixture/${i}`,
                defaultModel: null,
                scripts: [],
                createdAt: fixture.epoch,
                updatedAt: fixture.epoch,
              });
              yield* sql`INSERT INTO orchestration_events (event_id,aggregate_kind,stream_id,stream_version,event_type,occurred_at,command_id,causation_event_id,correlation_id,actor_kind,payload_json,metadata_json)
            VALUES (${`event-${i}`},'project',${`project-${i}`},1,'project.created',${fixture.epoch},NULL,NULL,NULL,'server',${payload},'{}')`;
            }
          }),
        );
      }),
    );
    const store = await persistence.runPromise(Effect.service(OrchestrationEventStore));
    const replay = async (slow: boolean, take = fixture.replay.events) => {
      let count = 0;
      let last = 0;
      await persistence.runPromise(
        store.readFromSequence(0, fixture.replay.events).pipe(
          Stream.take(take),
          Stream.runForEach((event) =>
            Effect.gen(function* () {
              if (event.sequence !== last + 1) throw new Error("Replay sequence gap");
              last = event.sequence;
              count++;
              if (slow && count % fixture.replay.slowPauseEvery === 0)
                yield* Effect.promise(() => delay(1));
            }),
          ),
        ),
      );
      expect(count).toBe(take);
    };
    report.measurements["replay.20000"] = await measure(() => replay(false), method);
    report.observations.push(maximumObservation("replay.pageEvents", replayPageRows, 200));
    report.observations.push(
      maximumObservation("replay.pageSerializedBytes", replayPageBytes, 1024 * 1024),
    );
    await uploadRuntime.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`PRAGMA foreign_keys = ON`;
        yield* sql`CREATE TABLE projection_threads (thread_id TEXT PRIMARY KEY)`;
        yield* sql`INSERT INTO projection_threads (thread_id) VALUES ('perf-upload')`;
        yield* ensureAttachmentSchema;
      }),
    );
    const uploadBytes = Buffer.alloc(1024 * 1024, 1);
    // PNG signature; ingestion validates MIME/size, it does not decode pixels.
    uploadBytes.set([137, 80, 78, 71, 13, 10, 26, 10]);
    const attachments = Array.from({ length: PROVIDER_SEND_TURN_MAX_ATTACHMENTS }, (_, i) => ({
      type: "image" as const,
      name: `fixture-${i}.png`,
      mimeType: "image/png",
      sizeBytes: uploadBytes.length,
      dataUrl: `data:image/png;base64,${uploadBytes.toString("base64")}`,
    }));
    let uploadPeakBytes = 0;
    let uploadIndex = 0;
    report.measurements["upload.decode-persist-release-8MiB"] = await measure(async () => {
      await uploadRuntime.runPromise(
        Effect.gen(function* () {
          const commandId = CommandId.makeUnsafe(`perf-upload-${uploadIndex++}`);
          const prepared = yield* prepareAttachmentIngress({
            attachments,
            attachmentsDir: path.join(directory, "uploads"),
            commandId,
            threadId: ThreadId.makeUnsafe("perf-upload"),
          });
          uploadPeakBytes = Math.max(
            uploadPeakBytes,
            prepared.entries.reduce((sum, entry) => sum + (entry.bytes?.length ?? 0), 0),
          );
          yield* persistPreparedAttachmentIngress(prepared);
          expect(prepared.entries.every((entry) => entry.bytes === undefined)).toBe(true);
          yield* discardAttachmentIngress({
            attachments: prepared.attachments,
            attachmentsDir: path.join(directory, "uploads"),
            commandId,
          });
        }),
      );
    }, method);
    report.observations.push(
      maximumObservation(
        "upload.decodedBuffersBytes",
        uploadPeakBytes,
        PROVIDER_SEND_TURN_MAX_ATTACHMENTS * PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
      ),
    );
    const writer = fork(
      fileURLToPath(new URL("./sqlite-writer.mjs", import.meta.url)),
      [database],
      { execArgv: [], stdio: ["ignore", "ignore", "pipe", "ipc"] },
    );
    const exited = once(writer, "exit");
    let writerError = "";
    writer.stderr?.on("data", (data) => {
      writerError = (writerError + String(data)).slice(-4096);
    });
    try {
      const ready = await Promise.race([
        once(writer, "message", { signal: AbortSignal.timeout(10000) }),
        exited.then(() => {
          throw new Error(`Writer exited before ready: ${writerError}`);
        }),
      ]);
      expect(ready[0]).toEqual({ ready: true });
      report.measurements["replay.slow-reader-with-writer"] = await measure(
        () => replay(true),
        method,
      );
      report.measurements["replay.cancel-after-1000-with-writer"] = await measure(
        () => replay(true, fixture.replay.disconnectAfter),
        method,
      );
      const summary = once(writer, "message", { signal: AbortSignal.timeout(10000) });
      writer.send("stop");
      const [counts] = (await summary) as [{ writes: number; failures: number }];
      expect(counts.writes).toBeGreaterThan(0);
      report.observations.push(
        maximumObservation("sqlite.concurrentWriterFailures", counts.failures, 0),
      );
      await exited;
    } finally {
      if (writer.exitCode === null && writer.signalCode === null) {
        writer.kill();
        await exited;
      }
    }
    const repository = path.join(directory, "repository");
    createRepository(repository);
    const core = await gitRuntime.runPromise(Effect.service(GitCore));
    const status = await gitRuntime.runPromise(core.statusDetails(repository));
    expect(status.hasWorkingTreeChanges).toBe(true);
    expect(status.workingTree.files.some((file) => file.path === repositoryFile(0).path)).toBe(
      true,
    );
    report.measurements["git.status-large-nested-submodules"] = await measure(async () => {
      await gitRuntime.runPromise(core.statusDetails(repository));
    }, method);
    // Correctness is checked outside timing as well, so a fast empty result cannot pass.
    expect(readFileSync(path.join(repository, ".gitmodules"), "utf8")).toContain("modules/sub-1");
  } finally {
    readSpy.mockRestore();
    terminals.dispose();
    await uploadRuntime.dispose();
    await persistence.dispose();
    await gitRuntime.dispose();
    rmSync(directory, { recursive: true, force: true });
  }
  mkdirSync(path.dirname(output), { recursive: true });
  writeFileSync(output, JSON.stringify(report, null, 2) + "\n", { flag: "wx" });
}, 600_000);
