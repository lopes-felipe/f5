/** Opt-in, isolated protocol certification. Never prints credentials or sampled text. */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ThreadId } from "@t3tools/contracts";
import { CodexAppServerManager, CodexJsonRpcError } from "../src/codexAppServerManager";

if (process.env.F5_CODEX_LIVE_TEST !== "1") throw new Error("Set F5_CODEX_LIVE_TEST=1.");
const root = await fs.mkdtemp(path.join(os.tmpdir(), "f5-release5-"));
const home = path.join(root, "home");
const cwd = path.join(root, "workspace");
const source =
  process.env.F5_CODEX_CERTIFICATION_HOME ??
  process.env.CODEX_HOME ??
  path.join(os.homedir(), ".codex");
const manager = new CodexAppServerManager();
const id = ThreadId.makeUnsafe("release5-certification");
const internal = manager as unknown as {
  requireSession(id: ThreadId): { nextRequestId: number };
  sendRequest(context: unknown, method: string, params: unknown): Promise<unknown>;
};
const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" ? (value as Record<string, unknown>) : {};
try {
  await fs.mkdir(home);
  await fs.mkdir(cwd);
  await fs.copyFile(path.join(source, "auth.json"), path.join(home, "auth.json"));
  await fs.chmod(path.join(home, "auth.json"), 0o600);
  const session = await manager.startSession({
    threadId: id,
    provider: "codex",
    cwd,
    runtimeMode: "full-access",
    providerOptions: {
      codex: { binaryPath: process.env.CODEX_BINARY_PATH ?? "codex", homePath: home },
    },
  });
  const context = internal.requireSession(id);
  const threadId = object(session.resumeCursor).threadId;
  const request = async (method: string, params: unknown) =>
    object(await internal.sendRequest(context, method, params));
  let completed = false;
  manager.on("event", (event) => {
    if (event.method === "turn/completed") completed = true;
  });
  await manager.sendTurn({
    threadId: id,
    input: "Reply exactly READY. Do not use tools or modify files.",
  });
  const deadline = Date.now() + 120_000;
  while (!completed && Date.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, 50));
  assert(completed, "First turn did not settle.");
  const before = await request("thread/turns/list", { threadId, limit: 100 });
  const turns = before.data as Array<{ id: string }>;
  const expectedTurnId = turns[0]!.id;
  const answer = await request("thread/sample", {
    threadId,
    expectedTurnId,
    prompt: "Reply exactly ASIDE.",
  });
  assert.equal(typeof answer.text, "string");
  const after = await request("thread/turns/list", { threadId, limit: 100 });
  assert.deepEqual(after.data, before.data, "Sample mutated source turns.");
  console.log("PASS thread/sample preserves history");
  const requestId = context.nextRequestId;
  const sampling = request("thread/sample", {
    threadId,
    expectedTurnId,
    prompt: "Explain the purpose of this conversation at length.",
  });
  const cancel = request("thread/sample/cancel", { requestId });
  await Promise.allSettled([sampling, cancel]);
  console.log("CHECK thread/sample/cancel dispatched");
  await request("thread/memory/read", { threadId });
  console.log("PASS thread/memory/read");
  const read = await request("thread/read", { threadId, includeTurns: false });
  const state = object(read.readState);
  assert.equal(typeof state.revision, "string");
  await request("thread/readState/update", {
    threadId,
    expectedRevision: state.revision,
    operation: { type: "unread" },
  });
  await assert.rejects(
    request("thread/readState/update", {
      threadId,
      expectedRevision: state.revision,
      operation: { type: "read" },
    }),
    (error) =>
      error instanceof CodexJsonRpcError && object(error.data).reason === "readStateConflict",
  );
  const current = await request("thread/read", { threadId, includeTurns: false });
  await request("thread/readState/update", {
    threadId,
    expectedRevision: object(current.readState).revision,
    operation: { type: "read" },
  });
  console.log("PASS read marks and conflict");
  await request("thread/goal/set", {
    threadId,
    objective: "Certification",
    status: "paused",
    tokenBudget: 1000,
    origin: "user",
  });
  await request("thread/goal/set", { threadId, status: "paused", origin: "automatic" });
  await request("thread/goal/clear", { threadId, origin: "user" });
  console.log("PASS goal origins");
} finally {
  await manager.shutdown();
  await fs.rm(root, { recursive: true, force: true });
}
