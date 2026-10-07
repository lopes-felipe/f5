/** Opt-in model-backed rewind certification, isolated from the operator's profile. */
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import assert from "node:assert/strict";
import { CodexAppServerManager } from "../src/codexAppServerManager.ts";
import { ThreadId } from "@t3tools/contracts";

if (process.env.F5_CODEX_LIVE_TEST !== "1")
  throw new Error("Set F5_CODEX_LIVE_TEST=1 to run model-backed certification.");
const source = process.env.F5_CODEX_CERTIFICATION_HOME ?? process.env.CODEX_HOME;
const binary = process.env.CODEX_BINARY_PATH;
if (!source || !binary)
  throw new Error("Set CODEX_BINARY_PATH and F5_CODEX_CERTIFICATION_HOME (or CODEX_HOME).");
const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "f5-codex-live-rewind-"));
const home = path.join(temporary, "home");
const cwd = path.join(temporary, "workspace");
const manager = new CodexAppServerManager();
const threadId = ThreadId.makeUnsafe("f5-release-zero-live");
const completions: Array<Record<string, unknown>> = [];
const methods: string[] = [];
// Audit-only access: capture real outgoing methods without logging params or secrets.
const native = manager as unknown as {
  requireSession(id: ThreadId): unknown;
  sendRequest(context: unknown, method: string, params: unknown): Promise<unknown>;
};
const sendRequest = native.sendRequest.bind(manager);
native.sendRequest = (context, method, params) => {
  methods.push(method);
  return sendRequest(context, method, params);
};
manager.on("event", (event) => {
  if (event.method === "turn/completed") completions.push(record(record(event.payload).turn));
});
let model = process.env.F5_CODEX_CERTIFICATION_MODEL ?? "gpt-5.4";
async function turn() {
  const count = completions.length;
  await manager.sendTurn({
    threadId,
    input: "Reply exactly READY. Do not use tools or modify any files.",
    model,
    effort: "low",
  });
  const deadline = Date.now() + 90_000;
  while (completions.length === count && Date.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(completions.length, count + 1, "Turn completion timeout");
  assert.equal(
    completions.at(-1)?.status,
    "completed",
    "Native model turn failed; check account/model availability.",
  );
}
async function start(executable: string, resumeCursor?: unknown) {
  return manager.startSession({
    threadId,
    provider: "codex",
    cwd,
    model,
    runtimeMode: "approval-required",
    ...(resumeCursor ? { resumeCursor } : {}),
    providerOptions: { codex: { binaryPath: executable, homePath: home } },
  });
}
try {
  await fs.mkdir(home);
  await fs.mkdir(cwd);
  await fs.copyFile(path.join(source, "auth.json"), path.join(home, "auth.json"));
  await fs.chmod(path.join(home, "auth.json"), 0o600);
  try {
    await fs.copyFile(path.join(source, "config.toml"), path.join(home, "config.toml"));
    await fs.chmod(path.join(home, "config.toml"), 0o600);
  } catch (error) {
    if (record(error).code !== "ENOENT") throw error;
  }
  await start(binary);
  if (!process.env.F5_CODEX_CERTIFICATION_MODEL) {
    const catalog = record(
      await sendRequest(native.requireSession(threadId), "model/list", { limit: 100 }),
    );
    const visible = Array.isArray(catalog.data)
      ? catalog.data.map(record).filter((entry) => !entry.hidden)
      : [];
    const chosen = visible.find((entry) => entry.isDefault) ?? visible[0];
    if (typeof chosen?.model === "string") model = chosen.model;
  }
  await turn();
  await turn();
  const before = await manager.readThread(threadId);
  assert.equal(before.turns.length, 2);
  if (process.env.F5_CODEX_RESUME_BINARY) {
    const cursor = manager.listSessions()[0]!.resumeCursor;
    manager.stopSession(threadId);
    await start(process.env.F5_CODEX_RESUME_BINARY, cursor);
  }
  methods.length = 0;
  let adoptedCursor: unknown;
  const after = await manager.rollbackThread(threadId, 1, undefined, async (session) => {
    adoptedCursor = session.resumeCursor;
  });
  assert.deepEqual(
    after.turns.map((turn) => turn.id),
    before.turns.slice(0, 1).map((turn) => turn.id),
  );
  assert.ok(adoptedCursor, "Adoption receipt missing");
  const rewindMethods = methods.filter((method) =>
    ["thread/revert", "thread/rollback", "thread/fork"].includes(method),
  );
  await turn();
  assert.equal((await manager.readThread(threadId)).turns.length, 2);
  console.log(
    JSON.stringify({
      status: "passed",
      model,
      rewindMethods,
      retainedHistoryValidated: true,
      followupCompleted: true,
    }),
  );
} finally {
  manager.stopAll();
  await new Promise((resolve) => setTimeout(resolve, 1500));
  await fs.rm(temporary, { recursive: true, force: true });
}
