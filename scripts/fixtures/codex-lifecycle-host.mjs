#!/usr/bin/env node
// Scripted native transport for lifecycle tests. It never contacts a provider.
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";

if (process.argv.includes("--version")) {
  console.log("codex-cli 0.121.0");
  process.exit(0);
}
if (process.argv.includes("login")) {
  console.log("Logged in using an API key");
  process.exit(0);
}

const home = process.env.CODEX_HOME;
if (!home) throw new Error("The lifecycle fixture requires a private CODEX_HOME");
mkdirSync(home, { recursive: true });
let thread = { id: randomUUID(), turns: [] };
let active;
let timer;
let approval;
let closing = false;
const write = (frame, callback) => process.stdout.write(`${JSON.stringify(frame)}\n`, callback);
const notify = (method, params) => write({ method, params });
const save = () => writeFileSync(join(home, `lifecycle-${thread.id}.json`), JSON.stringify(thread));
const item = () => active?.items[0];
const emitDelta = () => {
  if (!active || approval) return;
  const delta = `Desktop stream ${active.items[0].text.split("\n").length}\n`;
  item().text += delta;
  save();
  notify("item/agentMessage/delta", {
    threadId: thread.id,
    turnId: active.id,
    itemId: item().id,
    delta,
  });
};
const finish = (status) => {
  clearInterval(timer);
  timer = undefined;
  approval = undefined;
  if (!active) return;
  active.status = status;
  save();
  notify("item/completed", { threadId: thread.id, turnId: active.id, item: item() });
  notify("turn/completed", { threadId: thread.id, turn: active });
  active = undefined;
};
const shutdown = () => {
  if (closing) return;
  closing = true;
  finish("interrupted");
  write({ method: "thread/closed", params: { threadId: thread.id } }, () => process.exit(0));
};
const input = createInterface({ input: process.stdin });
input.on("close", shutdown);
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
input.on("line", (line) => {
  const request = JSON.parse(line);
  if (!request.method) {
    if (request.id === approval) {
      approval = undefined;
      emitDelta();
    }
    return;
  }
  const params = request.params ?? {};
  let result = {};
  switch (request.method) {
    case "initialize":
      result = { userAgent: "f5-lifecycle-fixture" };
      break;
    case "account/read":
      result = { account: { type: "apiKey" }, requiresOpenaiAuth: false };
      break;
    case "account/rateLimits/read":
      result = { rateLimits: null };
      break;
    case "model/list":
      result = {
        data: [
          { id: "gpt-5.4", model: "gpt-5.4", displayName: "Lifecycle fixture", isDefault: true },
        ],
        nextCursor: null,
      };
      break;
    case "skills/list":
      result = { data: [] };
      break;
    case "thread/start":
      thread = { id: randomUUID(), turns: [] };
      save();
      result = { thread };
      break;
    case "thread/resume":
      thread = JSON.parse(readFileSync(join(home, `lifecycle-${params.threadId}.json`), "utf8"));
      result = { thread };
      break;
    case "thread/read":
      result = { thread };
      break;
    case "thread/turns/list":
      result = { data: thread.turns, nextCursor: null };
      break;
    case "turn/start": {
      finish("interrupted");
      active = {
        id: randomUUID(),
        status: "inProgress",
        itemsView: "full",
        items: [{ type: "agentMessage", id: randomUUID(), text: "" }],
      };
      thread.turns.push(active);
      save();
      result = { turn: active };
      // RPC acknowledgement precedes notifications, as in the native transport.
      write({ id: request.id, result });
      notify("turn/started", { threadId: thread.id, turn: active });
      notify("item/started", { threadId: thread.id, turnId: active.id, item: item() });
      const prompt = (params.input ?? []).map((part) => part.text ?? "").join("");
      if (prompt.trimStart().startsWith("F5_SMOKE_APPROVAL")) {
        approval = `approval-${active.id}`;
        write({
          id: approval,
          method: "item/commandExecution/requestApproval",
          params: {
            threadId: thread.id,
            turnId: active.id,
            itemId: `command-${active.id}`,
            command: "echo desktop-smoke",
            availableDecisions: ["accept", "decline"],
          },
        });
      } else emitDelta();
      if (prompt.trimStart().startsWith("F5_SMOKE_")) timer = setInterval(emitDelta, 100);
      else finish("completed");
      return;
    }
    case "turn/interrupt":
      finish("interrupted");
      break;
    default:
      if (request.id === undefined) return;
      write({
        id: request.id,
        error: { code: -32601, message: `Unsupported fixture method: ${request.method}` },
      });
      return;
  }
  if (request.id !== undefined) write({ id: request.id, result });
});
