import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  CommandId,
  EventId,
  type OrchestrationCommand,
  type OrchestrationReadModel,
  ProjectId,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import { DatabaseSync } from "node:sqlite";
import { Effect } from "effect";
import { afterEach, describe, expect, it } from "vitest";

import type { OrchestrationEngineShape } from "../orchestration/Services/OrchestrationEngine.ts";
import {
  inspectStuckTurns,
  parseCanonicalTurnCompletedLine,
  parseNativeTurnCompletedLine,
  repairConfirmedCompletedTurn,
  repairStaleTerminalPointer,
} from "./StuckTurnRepair.ts";

const tempDirs: string[] = [];

afterEach(() => {
  for (const directory of tempDirs.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function makeTempDir(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "f5-stuck-turn-repair-"));
  tempDirs.push(directory);
  return directory;
}

const completedEvent = {
  type: "turn.completed",
  eventId: EventId.makeUnsafe("event-repair-completed"),
  provider: "codex",
  threadId: ThreadId.makeUnsafe("thread-repair"),
  turnId: TurnId.makeUnsafe("turn-repair"),
  createdAt: "2026-08-18T08:00:00.000Z",
  payload: { state: "completed" },
} as const;

describe("stuck turn repair inspection", () => {
  it("parses only canonical turn completion lines", () => {
    const line = `[2026-08-18T08:00:00.000Z] CANON: ${JSON.stringify(completedEvent)}`;
    expect(parseCanonicalTurnCompletedLine(line)).toEqual(completedEvent);
    expect(parseCanonicalTurnCompletedLine(line.replace("CANON", "NTIVE"))).toBeNull();
  });

  it("recognizes exact native Codex and Claude completion records", () => {
    const codex = parseNativeTurnCompletedLine(
      `[2026-08-18T08:00:00.000Z] NTIVE: ${JSON.stringify({
        id: "native-codex-completed",
        kind: "notification",
        provider: "codex",
        threadId: "thread-repair",
        turnId: "turn-repair",
        createdAt: "2026-08-18T08:00:00.000Z",
        method: "turn/completed",
        payload: { turn: { id: "turn-repair", status: "completed", error: null } },
      })}`,
      "thread-repair",
    );
    expect(codex).toMatchObject({
      type: "turn.completed",
      eventId: "native-codex-completed",
      provider: "codex",
      threadId: "thread-repair",
      turnId: "turn-repair",
      payload: { state: "completed" },
    });

    const claude = parseNativeTurnCompletedLine(
      `[2026-08-18T08:00:00.000Z] NTIVE: ${JSON.stringify({
        observedAt: "2026-08-18T08:00:00.000Z",
        event: {
          id: "native-claude-completed",
          kind: "notification",
          provider: "claudeAgent",
          providerThreadId: "provider-thread",
          turnId: "turn-repair",
          createdAt: "2026-08-18T08:00:00.000Z",
          method: "claude/result/success",
          payload: {
            is_error: false,
            subtype: "success",
            terminal_reason: "completed",
            stop_reason: "end_turn",
          },
        },
      })}`,
      "thread-repair",
    );
    expect(claude).toMatchObject({
      type: "turn.completed",
      eventId: "native-claude-completed",
      provider: "claudeAgent",
      threadId: "thread-repair",
      turnId: "turn-repair",
      payload: { state: "completed", stopReason: "end_turn" },
    });
  });

  it("dry-runs without mutating the database and selects exact matches", async () => {
    const stateDir = makeTempDir();
    const dbPath = path.join(stateDir, "state.sqlite");
    const providerLogsDir = path.join(stateDir, "logs", "provider");
    fs.mkdirSync(providerLogsDir, { recursive: true });
    const database = new DatabaseSync(dbPath);
    database.exec(`
      CREATE TABLE projection_threads (thread_id TEXT PRIMARY KEY, title TEXT NOT NULL);
      CREATE TABLE projection_thread_sessions (
        thread_id TEXT PRIMARY KEY, status TEXT NOT NULL, active_turn_id TEXT, updated_at TEXT NOT NULL
      );
      CREATE TABLE projection_turns (
        thread_id TEXT NOT NULL, turn_id TEXT, state TEXT NOT NULL,
        processing_quiesced_at TEXT
      );
      CREATE TABLE projection_thread_messages (
        thread_id TEXT NOT NULL, turn_id TEXT, role TEXT NOT NULL, is_streaming INTEGER NOT NULL,
        text TEXT NOT NULL
      );
      CREATE TABLE next_turn_queue (
        thread_id TEXT NOT NULL, status TEXT NOT NULL, deleted_at TEXT
      );
      INSERT INTO projection_threads VALUES ('thread-repair', 'Repair me');
      INSERT INTO projection_thread_sessions VALUES (
        'thread-repair', 'running', 'turn-repair', '2026-08-18T08:00:00.000Z'
      );
      INSERT INTO projection_turns VALUES ('thread-repair', 'turn-repair', 'running', NULL);
      INSERT INTO projection_thread_messages VALUES (
        'thread-repair', 'turn-repair', 'assistant', 0, 'Final response'
      );
      INSERT INTO next_turn_queue VALUES ('thread-repair', 'queued', NULL);
    `);
    database.close();
    fs.writeFileSync(
      path.join(providerLogsDir, "_global.log"),
      `[2026-08-18T08:00:00.000Z] CANON: ${JSON.stringify(completedEvent)}\n`,
    );
    const before = fs.readFileSync(dbPath);

    const inspections = await inspectStuckTurns({ dbPath, providerLogsDir });

    expect(inspections).toEqual([
      {
        threadId: "thread-repair",
        title: "Repair me",
        activeTurnId: "turn-repair",
        queuedCount: 1,
        reason: "eligible",
        event: completedEvent,
      },
    ]);
    expect(fs.readFileSync(dbPath)).toEqual(before);

    fs.rmSync(path.join(providerLogsDir, "_global.log"));
    const nativeEvent = {
      id: "native-codex-completed",
      kind: "notification",
      provider: "codex",
      threadId: "thread-repair",
      turnId: "turn-repair",
      createdAt: "2026-08-18T08:00:00.000Z",
      method: "turn/completed",
      payload: { turn: { id: "turn-repair", status: "completed", error: null } },
    };
    fs.writeFileSync(
      path.join(providerLogsDir, "thread-repair.log"),
      `[2026-08-18T08:00:00.000Z] NTIVE: ${JSON.stringify(nativeEvent)}\n`,
    );
    const nativeInspections = await inspectStuckTurns({ dbPath, providerLogsDir });
    expect(nativeInspections).toHaveLength(1);
    expect(nativeInspections[0]).toMatchObject({
      reason: "eligible",
      event: { eventId: "native-codex-completed", turnId: "turn-repair" },
    });
  });

  it("selects a queued terminal turn with a stale active pointer without log evidence", async () => {
    const stateDir = makeTempDir();
    const dbPath = path.join(stateDir, "state.sqlite");
    const providerLogsDir = path.join(stateDir, "logs", "provider");
    fs.mkdirSync(providerLogsDir, { recursive: true });
    const database = new DatabaseSync(dbPath);
    database.exec(`
      CREATE TABLE projection_threads (thread_id TEXT PRIMARY KEY, title TEXT NOT NULL);
      CREATE TABLE projection_thread_sessions (
        thread_id TEXT PRIMARY KEY, status TEXT NOT NULL, active_turn_id TEXT, updated_at TEXT NOT NULL
      );
      CREATE TABLE projection_turns (
        thread_id TEXT NOT NULL, turn_id TEXT, state TEXT NOT NULL,
        processing_quiesced_at TEXT
      );
      CREATE TABLE projection_thread_messages (
        thread_id TEXT NOT NULL, turn_id TEXT, role TEXT NOT NULL, is_streaming INTEGER NOT NULL,
        text TEXT NOT NULL
      );
      CREATE TABLE next_turn_queue (
        thread_id TEXT NOT NULL, status TEXT NOT NULL, deleted_at TEXT
      );
      INSERT INTO projection_threads VALUES ('thread-repair', 'Repair pointer');
      INSERT INTO projection_thread_sessions VALUES (
        'thread-repair', 'ready', 'turn-repair', '2026-08-18T08:00:00.000Z'
      );
      INSERT INTO projection_turns VALUES (
        'thread-repair', 'turn-repair', 'completed', '2026-08-18T08:00:00.000Z'
      );
      INSERT INTO projection_thread_messages VALUES (
        'thread-repair', 'turn-repair', 'assistant', 0, 'Final response'
      );
      INSERT INTO next_turn_queue VALUES ('thread-repair', 'queued', NULL);
    `);
    database.close();
    const before = fs.readFileSync(dbPath);

    expect(await inspectStuckTurns({ dbPath, providerLogsDir })).toEqual([
      {
        threadId: "thread-repair",
        title: "Repair pointer",
        activeTurnId: "turn-repair",
        queuedCount: 1,
        reason: "eligible_stale_terminal_pointer",
        event: null,
      },
    ]);
    expect(fs.readFileSync(dbPath)).toEqual(before);
  });
});

describe("repairConfirmedCompletedTurn", () => {
  function makeEngine(activeTurnId: TurnId | null = completedEvent.turnId) {
    const commands: OrchestrationCommand[] = [];
    const readModel = {
      snapshotSequence: 1,
      projects: [],
      threads: [
        {
          id: completedEvent.threadId,
          projectId: ProjectId.makeUnsafe("project-repair"),
          model: "gpt-5.6-sol",
          estimatedContextTokens: null,
          modelSelection: null,
          session: {
            status: "running",
            activeTurnId,
            runtimeMode: "full-access",
          },
          latestTurn: {
            turnId: completedEvent.turnId,
            state: "running",
          },
          messages: [
            {
              role: "assistant",
              turnId: completedEvent.turnId,
              streaming: false,
              text: "Final response",
            },
          ],
        },
      ],
    } as unknown as OrchestrationReadModel;
    const engine = {
      getReadModel: () => Effect.succeed(readModel),
      dispatch: (command: OrchestrationCommand) => {
        commands.push(command);
        return Effect.succeed({ sequence: commands.length });
      },
    } as unknown as OrchestrationEngineShape;
    return { engine, commands };
  }

  it("dispatches lifecycle before usage for an exact confirmed match", async () => {
    const { engine, commands } = makeEngine();
    const result = await Effect.runPromise(
      repairConfirmedCompletedTurn({ engine, event: completedEvent }),
    );

    expect(result).toEqual({ status: "repaired", reason: "repaired" });
    expect(commands.map((command) => command.type)).toEqual([
      "thread.session.set",
      "thread.usage.record",
    ]);
    expect(commands[0]?.commandId).toBe(
      CommandId.makeUnsafe("provider:event-repair-completed:thread-session-set"),
    );
    expect(commands[0]).toMatchObject({ settledTurnId: completedEvent.turnId });
  });

  it("refuses a completion whose active turn changed", async () => {
    const { engine, commands } = makeEngine(TurnId.makeUnsafe("turn-newer"));
    const result = await Effect.runPromise(
      repairConfirmedCompletedTurn({ engine, event: completedEvent }),
    );

    expect(result).toEqual({ status: "skipped", reason: "active_turn_mismatch" });
    expect(commands).toEqual([]);
  });

  it("is a no-op when the turn is already terminal", async () => {
    const { engine, commands } = makeEngine(null);
    const result = await Effect.runPromise(
      repairConfirmedCompletedTurn({ engine, event: completedEvent }),
    );

    expect(result).toEqual({ status: "skipped", reason: "already_terminal" });
    expect(commands).toEqual([]);
  });
});

describe("repairStaleTerminalPointer", () => {
  it("clears an exact stale pointer when latestTurn already presents queued work", async () => {
    const commands: OrchestrationCommand[] = [];
    const readModel = {
      snapshotSequence: 1,
      projects: [],
      threads: [
        {
          id: completedEvent.threadId,
          projectId: ProjectId.makeUnsafe("project-repair"),
          model: "gpt-5.6-sol",
          session: {
            threadId: completedEvent.threadId,
            status: "ready",
            providerName: "codex",
            activeTurnId: completedEvent.turnId,
            runtimeMode: "full-access",
            lastError: null,
            updatedAt: completedEvent.createdAt,
          },
          latestTurn: {
            turnId: TurnId.makeUnsafe("queued-presentation-turn"),
            state: "running",
          },
          messages: [
            {
              role: "assistant",
              turnId: completedEvent.turnId,
              streaming: false,
              text: "Final response",
            },
          ],
        },
      ],
    } as unknown as OrchestrationReadModel;
    const engine = {
      getReadModel: () => Effect.succeed(readModel),
      dispatch: (command: OrchestrationCommand) => {
        commands.push(command);
        return Effect.succeed({ sequence: commands.length });
      },
    } as unknown as OrchestrationEngineShape;

    const result = await Effect.runPromise(
      repairStaleTerminalPointer({
        engine,
        threadId: completedEvent.threadId,
        activeTurnId: completedEvent.turnId,
        createdAt: "2026-08-18T09:00:00.000Z",
      }),
    );

    expect(result).toEqual({ status: "repaired", reason: "repaired" });
    expect(commands).toHaveLength(1);
    expect(commands[0]).toMatchObject({
      type: "thread.session.set",
      commandId: "repair:stale-terminal-pointer:thread-repair:turn-repair",
      session: { status: "ready", activeTurnId: null },
    });
  });
});
