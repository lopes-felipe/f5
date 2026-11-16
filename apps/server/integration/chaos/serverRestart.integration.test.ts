import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import type { OrchestrationReadModel } from "@t3tools/contracts";
import { spawnJsonFixture } from "./process.ts";
import { connectStoreClient } from "./client.ts";
import { chaosTimeout } from "./timeouts.ts";

it.each([
  "before-send",
  "after-acceptance",
  "after-ack",
  "after-ack-before-output",
  "pending-receipts",
] as const)(
  "recovers a real server crash %s without resending ambiguous/accepted work",
  async (boundary) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "f5-server-crash-"));
    const launch = (mode: string) =>
      spawnJsonFixture({
        script: fileURLToPath(new URL("./restartServer.fixture.ts", import.meta.url)),
        args: [directory, mode],
        prefix: "F5_CHAOS:",
      });
    let server = launch(boundary);
    let client: Awaited<ReturnType<typeof connectStoreClient>> | undefined;
    const acceptances = () => {
      const file = path.join(directory, "provider-acceptances.ndjson");
      return fs.existsSync(file)
        ? fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean).length
        : 0;
    };
    const delivery = () => {
      const db = new DatabaseSync(path.join(directory, "state/state.sqlite"), { readOnly: true });
      try {
        return db
          .prepare(
            "SELECT state, certainty, outcome_projected_at AS projected, error_detail AS detail FROM provider_turn_deliveries WHERE command_id = 'crash-turn'",
          )
          .get() as
          | {
              state: string;
              certainty: string | null;
              projected: string | null;
              detail: string | null;
            }
          | undefined;
      } finally {
        db.close();
      }
    };
    const waitDelivery = async (state: string, projected: boolean) => {
      for (let attempt = 0; attempt < 300; attempt++) {
        const row = delivery();
        if (row?.state === state && (!projected || row.projected !== null)) return row;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      throw new Error(`Expected ${state}; observed ${JSON.stringify(delivery())}`);
    };
    try {
      const first = await server.next("ready");
      server.send("seed");
      await server.next("seed");
      client = await connectStoreClient(String(first.url));
      await client.next("ready");
      server.send("dispatch");
      await server.next("dispatch");
      if (boundary === "before-send") {
        await waitDelivery("pending", false);
        expect(acceptances()).toBe(0);
      } else if (boundary === "after-acceptance") {
        await server.next("accepted");
        await waitDelivery("sending", false);
        expect(acceptances()).toBe(1);
      } else if (boundary === "after-ack-before-output") {
        await server.next("projection-held");
        await waitDelivery("accepted", false);
        server.send("state");
        const before = (await server.next("state")).value as OrchestrationReadModel;
        expect(
          before.threads[0]!.messages.filter((message) => message.role === "assistant"),
        ).toEqual([]);
        expect(acceptances()).toBe(1);
      } else {
        await waitDelivery("accepted", true);
        // This fixture has no external durable provider history. Kill after the
        // acknowledged stream's projection barrier; the precise ack/output gap
        // needs a provider whose history survives in a separate process.
        server.send("settled");
        await server.next("settled");
        expect(acceptances()).toBe(1);
      }
      await server.kill();
      await client.next("closed");
      if (boundary === "pending-receipts") {
        const db = new DatabaseSync(path.join(directory, "state/state.sqlite"));
        try {
          const insert = db.prepare(
            "INSERT INTO provider_terminal_events (event_id, thread_id, turn_id, event_type, event_json, received_at, next_due_at, origin_provider_instance_id, origin_session_generation, origin_turn_id) VALUES (?, 'thread-1', 'turn-1', 'session.exited', ?, ?, ?, 'codex', 0, 'turn-1')",
          );
          const now = new Date().toISOString();
          insert.run("000-malformed", "{broken", now, now);
          for (let index = 0; index < 65; index++) {
            const id = `stale-receipt-${String(index).padStart(3, "0")}`;
            insert.run(
              id,
              JSON.stringify({
                type: "session.exited",
                eventId: id,
                provider: "codex",
                threadId: "thread-1",
                turnId: "turn-1",
                providerInstanceId: "codex",
                sessionGeneration: 0,
                createdAt: now,
                payload: { exitKind: "graceful" },
              }),
              now,
              now,
            );
          }
        } finally {
          db.close();
        }
      }
      server = launch("resume");
      const replacement = await server.next("ready");
      const recovered = await waitDelivery(
        boundary === "after-acceptance" ? "ambiguous" : "accepted",
        true,
      );
      if (boundary === "after-acceptance") expect(recovered.certainty).toBe("unknown");
      else {
        if (boundary === "after-ack-before-output") {
          server.send("recover-history");
          const recoveredHistory = (await server.next("recover-history")).value as {
            backfilledMessageCount: number;
          };
          expect(recoveredHistory.backfilledMessageCount).toBe(1);
        }
        server.send("settled");
        await server.next("settled");
      }
      if (boundary === "pending-receipts") {
        const readReceipts = () => {
          const db = new DatabaseSync(path.join(directory, "state/state.sqlite"), {
            readOnly: true,
          });
          try {
            return {
              applied: Number(
                db
                  .prepare(
                    "SELECT COUNT(*) AS count FROM provider_terminal_events WHERE event_id LIKE 'stale-receipt-%' AND applied_at IS NOT NULL",
                  )
                  .get()!.count,
              ),
              malformed: db
                .prepare(
                  "SELECT attempt, applied_at AS applied FROM provider_terminal_events WHERE event_id = '000-malformed'",
                )
                .get()!,
            };
          } finally {
            db.close();
          }
        };
        for (let attempt = 0; attempt < 500 && readReceipts().applied !== 65; attempt++)
          await new Promise((resolve) => setTimeout(resolve, 10));
        expect(readReceipts().applied).toBe(65);
        expect(readReceipts().malformed.attempt).toBeGreaterThan(0);
        expect(readReceipts().malformed.applied).toBeNull();
      }
      client.send("reconnect", { url: replacement.url });
      await client.next("ready");
      server.send("state");
      const state = (await server.next("state")).value as OrchestrationReadModel;
      client.send("inspect");
      expect((await client.next("state")).threads).toEqual(
        state.threads.map((thread) => ({
          id: thread.id,
          messages: thread.messages.map((message) => ({ id: message.id, text: message.text })),
        })),
      );
      expect(acceptances()).toBe(1);
      if (boundary === "after-acceptance")
        expect(recovered.detail).toMatch(/unknown|history|prove|accepted/i);
      if (boundary !== "after-acceptance")
        expect(
          state.threads[0]!.messages.filter((message) => message.text === "exact answer\n"),
        ).toHaveLength(1);
    } finally {
      await client?.close();
      await server.close();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  },
  chaosTimeout(45_000),
);
