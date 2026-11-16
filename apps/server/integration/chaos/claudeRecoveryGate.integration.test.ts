import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import type { OrchestrationReadModel } from "@t3tools/contracts";
import { COALESCE_STREAMING_DELTAS_DRIVERS } from "../../src/orchestration/streamingAssistantDeltas.ts";
import { readClaudeTranscript } from "../../src/provider/claudeTranscript.ts";
import type { ProviderThreadSnapshot } from "../../src/provider/Services/ProviderAdapter.ts";
import { spawnJsonFixture } from "./process.ts";
import { connectStoreClient } from "./client.ts";
import { chaosTimeout } from "./timeouts.ts";

it(
  "keeps Claude coalescing disabled while restart cannot reconstruct persisted native text",
  async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "f5-claude-crash-gate-"));
    const launch = () =>
      spawnJsonFixture({
        script: fileURLToPath(new URL("./claudeCrash.fixture.ts", import.meta.url)),
        args: [directory],
        prefix: "F5_CHAOS:",
      });
    let server = launch();
    let client: Awaited<ReturnType<typeof connectStoreClient>> | undefined;
    try {
      const first = await server.next("ready");
      server.send("seed");
      await server.next("seed");
      client = await connectStoreClient(String(first.url));
      await client.next("ready");
      server.send("dispatch");
      await server.next("dispatch");
      server.send("stream");
      await server.next("stream");
      await server.kill();
      await client.next("closed");
      const native = await readClaudeTranscript(
        path.join(directory, "claude/projects/fixture/550e8400-e29b-41d4-a716-446655440000.jsonl"),
      );
      expect(JSON.stringify([...native.values()])).toContain("recovered suffix");
      server = launch();
      const replacement = await server.next("ready");
      server.send("resume");
      const resumed = (await server.next("resume")).value as {
        history: ProviderThreadSnapshot;
        state: OrchestrationReadModel;
      };
      expect(resumed.history.history).toMatchObject({
        provenance: "runtime-local",
        coverage: "partial",
      });
      expect(resumed.history.turns).toEqual([]);
      expect(
        resumed.state.threads[0]!.messages.filter((message) => message.role === "assistant").map(
          (message) => message.text,
        ),
      ).toEqual(["\nClaude prefix "]);
      expect(COALESCE_STREAMING_DELTAS_DRIVERS.has("claudeAgent")).toBe(false);
      client.send("reconnect", { url: replacement.url });
      await client.next("ready");
      client.send("inspect");
      expect((await client.next("state")).threads).toEqual(
        resumed.state.threads.map((thread) => ({
          id: thread.id,
          messages: thread.messages.map((message) => ({ id: message.id, text: message.text })),
        })),
      );
    } finally {
      await client?.close();
      await server.close();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  },
  chaosTimeout(45_000),
);
