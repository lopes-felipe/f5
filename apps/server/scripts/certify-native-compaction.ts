/** Opt-in model-backed compaction acceptance. Never operates on an existing thread. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { CodexAppServerManager } from "../src/codexAppServerManager.ts";
import { ThreadId } from "@t3tools/contracts";

if (process.env.F5_CODEX_LIVE_TEST !== "1")
  throw new Error("Set F5_CODEX_LIVE_TEST=1 for model-backed certification.");
const source = process.env.F5_CODEX_CERTIFICATION_HOME ?? process.env.CODEX_HOME;
const binary = process.env.CODEX_BINARY_PATH;
if (!source || !binary)
  throw new Error("Set CODEX_BINARY_PATH and CODEX_HOME (or F5_CODEX_CERTIFICATION_HOME).");
const root = await fs.mkdtemp(path.join(os.tmpdir(), "f5-codex-compact-"));
const home = path.join(root, "home");
const cwd = path.join(root, "workspace");
const id = ThreadId.makeUnsafe("compaction-acceptance");
const manager = new CodexAppServerManager();
const sentinel = `F5_COMPACT_${randomUUID().replaceAll("-", "")}`;
const completed: string[] = [];
manager.on("event", (event) => {
  if (event.method !== "turn/completed") return;
  const turn = (event.payload as { turn?: { status?: string } }).turn;
  completed.push(turn?.status ?? "unknown");
});
const controller = new AbortController();
const timeout = setTimeout(() => controller.abort(), 170_000);
const start = (resumeCursor?: unknown) =>
  manager.startSession({
    threadId: id,
    provider: "codex",
    cwd,
    runtimeMode: "approval-required",
    providerOptions: { codex: { binaryPath: binary, homePath: home } },
    ...(resumeCursor ? { resumeCursor } : {}),
  });
async function turn(input: string) {
  const count = completed.length;
  await manager.sendTurn({ threadId: id, input, effort: "low" });
  while (completed.length === count && !controller.signal.aborted)
    await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(completed.length, count + 1, "Turn completion timed out");
  assert.equal(
    completed.at(-1),
    "completed",
    "Model turn failed; check account/model availability",
  );
}
try {
  await fs.mkdir(home);
  await fs.mkdir(cwd);
  await fs.copyFile(path.join(source, "auth.json"), path.join(home, "auth.json"));
  await fs.chmod(path.join(home, "auth.json"), 0o600);
  await start();
  await turn(
    `Remember this important project recovery token for future turns and summaries: ${sentinel}. Reply READY. Do not use tools.`,
  );
  let receipt: unknown;
  const result = await manager.executeNativeOperation(
    { threadId: id, generation: 1, operationId: randomUUID(), command: { kind: "compact" } },
    async (next) => {
      receipt = next;
    },
    controller.signal,
  );
  assert.equal((result as { status?: string }).status, "completed");
  assert.ok(
    (receipt as { nativeItemId?: string }).nativeItemId,
    "Missing correlated compaction item receipt",
  );
  const compacted = await manager.readThread(id);
  assert.ok(
    compacted.turns.some((t) =>
      t.items.some((item) => (item as { type?: string }).type === "contextCompaction"),
    ),
    "No compaction item in persisted history",
  );
  for (let attempt = 0; attempt < 2; attempt++) {
    const cursor = manager.listSessions()[0]!.resumeCursor;
    manager.stopSession(id);
    await start(cursor);
    await turn(
      "Reply with the exact project recovery token from earlier, and nothing else. Do not use tools.",
    );
    const history = await manager.readThread(id);
    const reply = history.turns
      .at(-1)!
      .items.filter((item) => (item as { type?: string }).type === "agentMessage");
    assert.ok(
      JSON.stringify(reply).includes(sentinel),
      "Resumed model lost the pre-compaction fact",
    );
  }
  console.log(
    JSON.stringify({
      status: "passed",
      correlatedCompaction: true,
      persistedCompaction: true,
      resumedTwice: true,
    }),
  );
} finally {
  clearTimeout(timeout);
  controller.abort();
  manager.stopAll();
  await new Promise((resolve) => setTimeout(resolve, 1500));
  await fs.rm(root, { recursive: true, force: true });
}
