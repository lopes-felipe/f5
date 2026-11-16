import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { Effect } from "effect";
import { makeEventNdjsonLogger } from "../../src/provider/Layers/EventNdjsonLogger.ts";
import { expect, it } from "vitest";
import {
  inspectStuckTurns,
  repairClaudeResumePoint,
} from "../../src/maintenance/StuckTurnRepair.ts";
import { hasClaudeParentChain, readClaudeTranscript } from "../../src/provider/claudeTranscript.ts";
import { spawnJsonFixture } from "./process.ts";
import { chaosTimeout } from "./timeouts.ts";

it(
  "both repair tools use complete evidence after the writer is killed mid-batch",
  async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "f5-log-repair-crash-"));
    const providerLogsDir = path.join(directory, "logs");
    const child = spawnJsonFixture({
      script: fileURLToPath(new URL("./logWriter.fixture.ts", import.meta.url)),
      args: [providerLogsDir],
      prefix: "F5_CHAOS:",
    });
    const dbPath = path.join(directory, "state.sqlite");
    const file = path.join(directory, "session.jsonl");
    try {
      await child.next("partial");
      await child.kill();
      const log = fs.readFileSync(path.join(providerLogsDir, "_global.log"), "utf8");
      expect(log.endsWith("\n")).toBe(false);
      expect(log).toContain('"eventId":"partial-completion"');
      const db = new DatabaseSync(dbPath);
      try {
        db.exec(`
        CREATE TABLE projection_threads (thread_id TEXT PRIMARY KEY, title TEXT NOT NULL);
        CREATE TABLE projection_thread_sessions (thread_id TEXT PRIMARY KEY, status TEXT NOT NULL, active_turn_id TEXT, updated_at TEXT NOT NULL);
        CREATE TABLE projection_turns (thread_id TEXT NOT NULL, turn_id TEXT, state TEXT NOT NULL, processing_quiesced_at TEXT);
        CREATE TABLE projection_thread_messages (thread_id TEXT NOT NULL, turn_id TEXT, role TEXT NOT NULL, is_streaming INTEGER NOT NULL, text TEXT NOT NULL);
        CREATE TABLE next_turn_queue (thread_id TEXT NOT NULL, status TEXT NOT NULL, deleted_at TEXT);
        INSERT INTO projection_threads VALUES ('thread-repair', 'Repair me');
        INSERT INTO projection_thread_sessions VALUES ('thread-repair', 'running', 'turn-repair', '2026-08-18T08:00:00.000Z');
        INSERT INTO projection_turns VALUES ('thread-repair', 'turn-repair', 'running', NULL);
        INSERT INTO projection_thread_messages VALUES ('thread-repair', 'turn-repair', 'assistant', 0, 'Final response');
      `);
      } finally {
        db.close();
      }
      const inspections = await inspectStuckTurns({ dbPath, providerLogsDir });
      expect(inspections).toHaveLength(1);
      expect(inspections[0]!.reason).not.toBe("eligible");
      fs.writeFileSync(
        file,
        JSON.stringify({
          cwd: "/project",
          sessionId: "session",
          version: "2.1",
          gitBranch: "main",
          isSidechain: false,
          timestamp: "2026-10-07T09:37:00.000Z",
          uuid: "root",
          parentUuid: null,
          type: "assistant",
          message: { role: "assistant", content: [{ type: "text", text: "saved" }] },
        }) + "\n",
      );
      const repaired = await repairClaudeResumePoint({
        file,
        target: "target",
        sessionId: "session",
        threadId: "thread-repair",
        providerLogsDir,
      });
      expect(repaired.status).toBe("repaired");
      const transcript = await readClaudeTranscript(file);
      expect(transcript.get("target")).toMatchObject({
        message: { content: expect.arrayContaining([{ type: "text", text: "recovered answer" }]) },
      });
      expect(hasClaudeParentChain(transcript, "target")).toBe(true);
      await Effect.runPromise(
        Effect.gen(function* () {
          const logger = yield* makeEventNdjsonLogger(
            path.join(providerLogsDir, "reopened.ndjson"),
            {
              stream: "canonical",
            },
          );
          if (!logger) throw new Error("Could not reopen writer");
          yield* logger.write(
            {
              type: "turn.completed",
              eventId: "fresh-completion",
              provider: "codex",
              threadId: "thread-repair",
              turnId: "turn-repair",
              createdAt: "2026-08-18T08:00:00.000Z",
              payload: { state: "completed" },
            },
            null,
          );
          yield* logger.close();
        }),
      );
      const reopened = fs.readFileSync(path.join(providerLogsDir, "_global.log"), "utf8");
      expect(reopened).not.toContain('"eventId":"partial-completion"');
      expect(reopened.endsWith("\n")).toBe(true);
      const confirmed = await inspectStuckTurns({ dbPath, providerLogsDir });
      expect(confirmed[0]).toMatchObject({
        reason: "eligible",
        event: { eventId: "fresh-completion" },
      });
    } finally {
      await child.close();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  },
  chaosTimeout(20_000),
);
