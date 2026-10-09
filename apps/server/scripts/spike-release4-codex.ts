/** Live, isolated Release 4 protocol spike. Emits method names and outcomes only. */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { CodexAppServerManager } from "../src/codexAppServerManager.ts";
import { ThreadId, ApprovalRequestId } from "@t3tools/contracts";
const root = await fs.mkdtemp(path.join(os.tmpdir(), "f5-release4-spike-"));
const home = path.join(root, "home");
const cwd = path.join(root, "workspace");
const source = process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex");
const manager = new CodexAppServerManager();
const id = ThreadId.makeUnsafe("release4-spike");
const native = manager as unknown as {
  requireSession(id: ThreadId): unknown;
  sendRequest(context: unknown, method: string, params: unknown): Promise<unknown>;
};
const events: string[] = [];
let reviewing = false;
const reviewEvents: unknown[] = [];
manager.on("event", (event) => {
  events.push(event.method ?? event.kind);
  if (reviewing && reviewEvents.length < 100)
    reviewEvents.push({
      method: event.method,
      turnId: event.turnId,
      turn: {
        id: record(record(event.payload).turn).id,
        status: record(record(event.payload).turn).status,
      },
      itemType: record(record(event.payload).item).type,
    });
  if (event.kind === "request" && event.requestId && /requestApproval/.test(event.method ?? "")) {
    void manager
      .respondToRequest(id, ApprovalRequestId.makeUnsafe(String(event.requestId)), "decline")
      .catch(() => undefined);
  }
  if (event.method === "item/completed") {
    const item = record(record(event.payload).item);
    if (typeof item.type === "string") events.push(`item:${item.type}`);
  }
});
const record = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" ? (v as Record<string, unknown>) : {};
const outcomes: Record<string, unknown> = {};
async function request(method: string, params: Record<string, unknown>) {
  try {
    const result = await native.sendRequest(native.requireSession(id), method, params);
    outcomes[method] = "accepted";
    return record(result);
  } catch (error) {
    outcomes[method] = error instanceof Error ? error.message.slice(0, 250) : "failed";
    return {};
  }
}
try {
  await fs.mkdir(home);
  await fs.mkdir(cwd);
  await fs.copyFile(path.join(source, "auth.json"), path.join(home, "auth.json"));
  await fs.chmod(path.join(home, "auth.json"), 0o600);
  const git = promisify(execFile);
  await git("git", ["init", cwd]);
  await fs.writeFile(path.join(cwd, "sample.js"), "export const value = 1;\n");
  await git("git", ["-C", cwd, "add", "sample.js"]);
  await git("git", [
    "-C",
    cwd,
    "-c",
    "user.name=F5 spike",
    "-c",
    "user.email=spike@example.invalid",
    "commit",
    "-m",
    "Spike fixture",
  ]);
  const session = await manager.startSession({
    threadId: id,
    provider: "codex",
    cwd,
    runtimeMode: "approval-required",
    providerOptions: {
      codex: { binaryPath: process.env.CODEX_BINARY_PATH ?? "codex", homePath: home },
    },
  });
  const cursor = record(session.resumeCursor);
  const threadId = cursor.threadId as string;
  const originalRequest = native.sendRequest.bind(manager);
  native.sendRequest = async (context, method, params) => {
    const result = await originalRequest(context, method, params);
    if (method === "review/start")
      outcomes.reviewResponse = {
        turnId: record(record(result).turn).id,
        status: record(record(result).turn).status,
        reviewThreadId: record(result).reviewThreadId,
      };
    return result;
  };
  const catalog = await request("model/list", { limit: 50 });
  const models = Array.isArray(catalog.data)
    ? catalog.data.map(record).filter((m) => !m.hidden)
    : [];
  const model = (models.find((m) => m.isDefault) ?? models[0])?.model as string;
  const waitFor = (method: string, count: number) =>
    new Promise<void>((resolve, reject) => {
      const start = Date.now();
      const timer = setInterval(() => {
        if (events.filter((m) => m === method).length > count) {
          clearInterval(timer);
          resolve();
        } else if (Date.now() - start > 60_000) {
          clearInterval(timer);
          reject(new Error(`${method} timeout`));
        }
      }, 50);
    });
  let count = events.filter((m) => m === "turn/completed").length;
  await manager.sendTurn({
    threadId: id,
    model,
    input: "Reply READY. No tools or file changes.",
    effort: "low",
  });
  await waitFor("turn/completed", count);
  const history = await manager.readThread(id);
  const beforeTurnId = history.turns[0]?.id;
  await request("thread/fork", { threadId, beforeTurnId, excludeTurns: true, cwd });
  await request("thread/fork", { threadId, excludeTurns: false, cwd });
  await request("thread/attachment/add", {
    threadId,
    attachmentType: "f5-spike",
    identityKey: "metadata-only",
    payload: { label: "spike" },
  });
  await request("thread/attachment/list", { threadId });
  await request("thread/goal/set", {
    threadId,
    objective: "Reply READY without using tools.",
    status: "paused",
    tokenBudget: 100,
  });
  await request("thread/goal/get", { threadId });
  await request("thread/goal/clear", { threadId });
  count = events.filter((m) => m === "turn/completed").length;
  await request("thread/goal/set", {
    threadId,
    objective: "Reply READY without tools and mark this goal complete.",
    status: "active",
    tokenBudget: 100,
  });
  try {
    await waitFor("turn/completed", count);
    outcomes.activeGoalSettlement = "turn/completed";
  } catch {
    outcomes.activeGoalSettlement = "no automatic turn within 60 seconds";
  }
  const activeGoal = await request("thread/goal/get", { threadId });
  outcomes.activeGoalStatus = record(activeGoal.goal).status;
  await request("thread/goal/set", { threadId, status: "paused" });
  await manager.interruptTurn(id);
  await request("thread/goal/clear", { threadId });
  count = events.filter((m) => m === "turn/completed").length;
  await request("thread/compact/start", { threadId });
  try {
    await waitFor("turn/completed", count);
    outcomes.compactionSettlement = "turn/completed";
  } catch {
    outcomes.compactionSettlement = "unverified";
  }
  await fs.writeFile(path.join(cwd, "sample.js"), "export const value = 2;\n");
  reviewing = true;
  try {
    const review = await manager.executeNativeOperation({
      threadId: id,
      operationId: crypto.randomUUID(),
      generation: 1,
      command: { kind: "review", target: { type: "uncommittedChanges" } },
    });
    outcomes.reviewSettlement = record(review).status;
  } catch (cause) {
    outcomes.reviewSettlement = cause instanceof Error ? cause.message : "unverified";
    await manager.interruptTurn(id);
  }
  const after = await manager.readThread(id);
  outcomes.compactionItems = after.turns
    .flatMap((t) => t.items.map((i) => record(i).type))
    .filter(Boolean);
  for (const method of [
    "model/list",
    "thread/fork",
    "thread/attachment/add",
    "thread/attachment/list",
    "thread/goal/set",
    "thread/goal/get",
    "thread/goal/clear",
    "thread/compact/start",
  ])
    assert.equal(outcomes[method], "accepted", `${method} failed`);
  assert.equal(outcomes.activeGoalSettlement, "turn/completed");
  assert.equal(outcomes.compactionSettlement, "turn/completed");
  assert.equal(outcomes.reviewSettlement, "completed");
  console.log(
    JSON.stringify(
      {
        outcomes,
        reviewEvents,
        notifications: [...new Set(events)].filter((m) =>
          /goal|attach|compact|turn\/|review|item:|requestApproval/.test(m),
        ),
      },
      null,
      2,
    ),
  );
} finally {
  manager.stopAll();
  await new Promise((resolve) => setTimeout(resolve, 1500));
  await fs.rm(root, { recursive: true, force: true });
}
