import * as FS from "node:fs/promises";
import * as OS from "node:os";
import * as Path from "node:path";
import { spawn } from "node:child_process";
import * as Http from "node:http";
import { afterEach, expect, it, vi } from "vitest";
import { Effect } from "effect";
import { z } from "zod";
import { CommandId, MessageId, ProviderInstanceId, ThreadId, TurnId } from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import {
  FakeAgentBridgeHost,
  project,
  thread,
  provider,
  emptyQueue,
} from "../agentBridge/testing/fakeHost.ts";
import { readAgentBridgeLocalCredentials } from "../agentBridge/localCredentials.ts";
import { startThreadCliListener } from "./listener.ts";
import { withThreadClient, resolveCliProject, readCliThread, type ToolCall } from "./client.ts";
import { finishCliSubmission, readCliMessage } from "./command.ts";
import {
  ownerCredentialsPath,
  projectsSchema,
  threadsSchema,
  submittedSchema,
  readSchema,
  waitSchema,
  sessionSchema,
} from "./protocol.ts";

async function cli(stateDir: string, args: string[], input = "") {
  const child = spawn("bun", ["src/index.ts", "--state-dir", stateDir, "thread", ...args], {
    cwd: new URL("../../", import.meta.url),
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, F5_PROFILE: "default", F5_STANDALONE: "0" },
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  child.stdin.end(input);
  const code = await new Promise<number | null>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", resolve);
  });
  return { code, stdout, stderr };
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  process.exitCode = 0;
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function setup() {
  const dir = await FS.mkdtemp(Path.join(OS.tmpdir(), "f5-thread-cli-"));
  cleanups.push(() => FS.rm(dir, { recursive: true, force: true }));
  const host = new FakeAgentBridgeHost();
  host.projects = [
    {
      ...project("private", dir),
      defaultModelSelection: createModelSelection(
        ProviderInstanceId.makeUnsafe("codex"),
        "coding-model",
      ),
    },
  ];
  host.settings = { ...host.settings, defaultRuntimeMode: "auto" };
  host.providers = [provider("codex", "codex", ["coding-model"])];
  const listener = await startThreadCliListener(host.shape, dir, "test");
  cleanups.push(() => listener.close());
  return { dir, host, listener };
}

it("uses all owner projects, project defaults and the common submission path without enabling the bridge", async () => {
  const { dir, host } = await setup();
  expect(host.settings.agentBridge.enabled).toBe(false);
  await withThreadClient(dir, async (call) => {
    expect((await call("f5_project_list", {}, projectsSchema)).projects[0]?.id).toBe("private");
    const sent = await call(
      "f5_thread_launch",
      { projectId: "private", prompt: "hello", title: "Hello" },
      submittedSchema,
    );
    const submission = host.submissions[0]!;
    expect(submission.submissionId).toBe(sent.submissionId);
    expect(submission.command.runtimeMode).toBe("auto");
    expect(submission.command.modelSelection?.model).toBe("coding-model");
    expect(submission.command.bootstrap?.prepareWorktree).toBeUndefined();
    expect(submission.command.bootstrap?.createThread?.projectId).toBe("private");
    await call(
      "f5_thread_launch",
      {
        projectId: "private",
        prompt: "isolated",
        title: "Worktree",
        worktree: "release",
        branch: "fix-cli",
      },
      submittedSchema,
    );
    expect(host.submissions[1]?.command.bootstrap?.prepareWorktree).toMatchObject({
      baseBranch: "release",
      branch: "fix-cli",
      requireWorktree: true,
    });
    await expect(
      call(
        "f5_thread_launch",
        {
          projectId: "private",
          prompt: "bad",
          title: "Bad",
          branch: "oops",
        },
        submittedSchema,
      ),
    ).rejects.toThrow("--branch needs --worktree");
    expect(host.submissions).toHaveLength(2);
  });
});

it("loads activities only for the requested recent page, even with unloaded old archives", async () => {
  const { dir, host } = await setup();
  host.threads = Array.from({ length: 250 }, (_, index) =>
    thread("t-" + index, "private", {
      updatedAt: new Date(2026, 0, index + 1).toISOString(),
      ...(index < 240 ? { archivedAt: "2026-01-01T00:00:00.000Z", activitiesOmitted: true } : {}),
    }),
  );
  const load = vi.spyOn(host.shape, "ensureThreadActivities");
  await withThreadClient(dir, async (call) => {
    const page = await call("f5_thread_list", { projectId: "private", limit: 10 }, threadsSchema);
    expect(page.threads).toHaveLength(10);
    expect(load).toHaveBeenCalledWith(
      host.threads
        .slice(240)
        .reverse()
        .map((t) => t.id),
    );
    expect(host.threads[0]?.activitiesOmitted).toBe(true);
  });
});

it("validates explicit providers and falls back when a project model is missing or disabled", async () => {
  const { dir, host } = await setup();
  await withThreadClient(dir, async (call) => {
    const launch = (extra = {}) =>
      call(
        "f5_thread_launch",
        {
          projectId: "private",
          prompt: "hello",
          title: "Hello",
          ...extra,
        },
        submittedSchema,
      );
    await expect(launch({ provider: "typo", model: "coding-model" })).rejects.toThrow(
      "Provider not found",
    );
    await expect(launch({ provider: "codex", model: "typo" })).rejects.toThrow("Unknown model");
    expect(host.submissions).toHaveLength(0);
    host.projects[0] = { ...host.projects[0]!, defaultModelSelection: null };
    await launch();
    expect(host.submissions[0]?.command.model).toBe("coding-model");
    host.projects[0] = {
      ...host.projects[0]!,
      defaultModelSelection: createModelSelection(
        ProviderInstanceId.makeUnsafe("disabled"),
        "old-model",
      ),
    };
    host.providers.push({ ...provider("disabled", "codex", ["old-model"]), enabled: false });
    await launch();
    expect(host.submissions[1]?.command.modelSelection?.instanceId).toBe("codex");
    host.settings = { ...host.settings, defaultThreadEnvMode: "worktree" };
    await launch();
    expect(host.submissions[2]?.command.bootstrap?.prepareWorktree).toMatchObject({
      baseBranch: "main",
      requireWorktree: true,
    });
  });
});

it("sends to legacy threads and preserves admission failure details", async () => {
  const { dir, host } = await setup();
  host.threads = [thread("legacy", "private")];
  await withThreadClient(dir, async (call) => {
    const sent = await call(
      "f5_thread_send",
      { threadId: "legacy", prompt: "hello" },
      submittedSchema,
    );
    expect(sent.delivery).toBe("started");
    expect(host.submissions[0]?.command.model).toBe("model-a");
    expect(host.submissions[0]?.command.modelSelection).toBeUndefined();
    vi.spyOn(host.shape, "submitTurnSubmission").mockImplementation((body) =>
      Effect.succeed({
        submissionId: body.submissionId,
        disposition: "rejected",
        reasonCode: "queue_full",
        detail: "Remove a queued message.",
      }),
    );
    await expect(
      call("f5_thread_send", { threadId: "legacy", prompt: "next" }, submittedSchema),
    ).rejects.toThrow("queue_full — Remove a queued message.");
  });
});

function setSubmittedStatus(
  host: FakeAgentBridgeHost,
  state: "waiting" | "paused" | "error" | "rejected" | "interrupted" | "running",
) {
  host.threads = [
    thread("legacy", "private", state === "waiting" ? { pendingUserInputs: [{}] as never } : {}),
  ];
  const original = host.shape.submitTurnSubmission;
  vi.spyOn(host.shape, "submitTurnSubmission").mockImplementation((body, options) =>
    original(body, options).pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          host.records.set(body.submissionId, {
            submissionId: body.submissionId,
            threadId: body.command.threadId,
            requestHash: "",
            itemId: null,
            messageId: body.command.message.messageId,
            disposition:
              state === "rejected" ? "rejected" : state === "interrupted" ? "started" : "queued",
            resultSequence: null,
            reasonCode: state === "rejected" ? "not_allowed" : null,
            createdAt: "",
            settledAt: "",
          });
          if (state === "paused" || state === "error")
            host.queues.set("legacy", {
              ...emptyQueue("legacy"),
              blockedKind: state,
              reasonDetail: state === "paused" ? "Paused by you" : "Queue error",
              items: [{ submissionId: body.submissionId, status: "pending" }] as never,
            });
          if (state === "interrupted") {
            const turnId = TurnId.makeUnsafe("turn");
            host.threads[0] = {
              ...host.threads[0]!,
              messages: [
                {
                  id: body.command.message.messageId,
                  role: "user",
                  text: "hello",
                  turnId,
                  streaming: false,
                  attachments: [],
                  createdAt: "",
                  updatedAt: "",
                },
              ],
            };
            host.turnStates.set(turnId, "interrupted");
          }
        }),
      ),
    ),
  );
}

it("preserves waiting, paused and failed exit codes through the real CLI teardown", async () => {
  for (const [state, code] of [
    ["waiting", 2],
    ["paused", 2],
    ["error", 1],
    ["rejected", 1],
    ["interrupted", 1],
  ] as const) {
    const { dir, host } = await setup();
    setSubmittedStatus(host, state);
    const result = await cli(dir, ["send", "legacy", "hello", "--wait", "--json"]);
    expect(result.code, result.stderr).toBe(code);
    expect(JSON.parse(result.stdout)).toMatchObject({
      threadId: "legacy",
      status: code === 2 ? "waiting" : state === "error" ? "blocked" : state,
    });
  }
}, 60_000);

it("revokes its temporary session when an actual waiting CLI receives SIGINT", async () => {
  if (process.platform === "win32") return; // Windows does not deliver POSIX SIGINT to child processes.
  const originalEmit = Http.Server.prototype.emit;
  let authorization = "";
  vi.spyOn(Http.Server.prototype, "emit").mockImplementation(function (
    this: Http.Server,
    event: string | symbol,
    ...args: unknown[]
  ) {
    if (event === "request")
      authorization = (args[0] as Http.IncomingMessage).headers.authorization ?? "";
    return Reflect.apply(originalEmit, this, [event, ...args]);
  });
  const { dir, host, listener } = await setup();
  setSubmittedStatus(host, "running");
  let entered!: () => void;
  const enteredWait = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const originalGet = host.shape.getSubmission;
  vi.spyOn(host.shape, "getSubmission").mockImplementation((id) => {
    entered();
    return originalGet(id);
  });
  const child = spawn(
    "bun",
    ["src/index.ts", "--state-dir", dir, "thread", "send", "legacy", "hello", "--wait"],
    {
      cwd: new URL("../../", import.meta.url),
      stdio: "ignore",
      env: { ...process.env, F5_PROFILE: "default", F5_STANDALONE: "0" },
    },
  );
  cleanups.push(async () => {
    if (child.exitCode === null) child.kill("SIGTERM");
  });
  const closed = new Promise<void>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", () => resolve());
  });
  await Promise.race([
    enteredWait,
    closed.then(() => {
      throw new Error("CLI exited before waiting");
    }),
  ]);
  const sessionAuthorization = authorization;
  child.kill("SIGINT");
  await closed;
  const response = await fetch("http://127.0.0.1:" + listener.port + "/mcp", {
    method: "POST",
    headers: { authorization: sessionAuthorization, "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
  });
  expect(response.status).toBe(401);
  await response.body?.cancel();
}, 30_000);

it("validates stdin before connecting and keeps unknown-profile stdio errors on one line", async () => {
  const { dir } = await setup();
  const empty = await cli(Path.join(dir, "not-running"), ["start", "private", "-"], " ");
  expect(empty.code).toBe(1);
  expect(empty.stderr).toContain("The message is empty.");
  expect(empty.stderr).not.toContain("No running F5");
  const child = spawn(
    "bun",
    ["src/index.ts", "--state-dir", dir, "--profile", "unknown", "agent-bridge-stdio"],
    {
      cwd: new URL("../../", import.meta.url),
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const code = await new Promise<number | null>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", resolve);
  });
  expect(code).toBe(1);
  expect(stderr.trim()).toBe("Unknown F5 profile 'unknown'.");
}, 30_000);

it("routes real terminal commands without starting a server or taking a profile lock", async () => {
  const { dir, host } = await setup();
  const start = await cli(dir, ["start", "private", "-", "--json"], "first line\nsecond line");
  expect(start.code, start.stderr).toBe(0);
  expect(JSON.parse(start.stdout)).toMatchObject({
    threadId: expect.any(String),
    submissionId: expect.any(String),
  });
  expect(host.submissions[0]?.command.message.text).toBe("first line\nsecond line");
  expect(host.submissions[0]?.command.bootstrap?.createThread?.title).toBe("first line");
  const list = await cli(dir, ["list", "--project", "private", "--json"]);
  expect(list.code, list.stderr).toBe(0);
  expect(JSON.parse(list.stdout)).toEqual([]);
  const missing = await cli(dir, ["show", "does-not-exist", "--json"]);
  expect(missing.code).toBe(1);
  expect(missing.stderr).toContain("Thread not found");
  expect(missing.stdout).toBe("");
}, 30_000);

it("queues to an unrestricted thread using its admitted modes and reads complete messages", async () => {
  const { dir, host } = await setup();
  const text = "full transcript ".repeat(5000);
  host.threads = [
    thread("existing", "private", {
      runtimeMode: "full-access",
      modelSelection: createModelSelection(
        ProviderInstanceId.makeUnsafe("codex"),
        "existing-model",
      ),
      messages: [
        {
          id: MessageId.makeUnsafe("reply"),
          role: "assistant",
          text,
          turnId: TurnId.makeUnsafe("turn"),
          streaming: false,
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
          attachments: [],
        },
      ],
    }),
  ];
  await withThreadClient(dir, async (call) => {
    await call("f5_thread_send", { threadId: "existing", prompt: "next" }, submittedSchema);
    expect(host.submissions[0]?.intent).toBe("queue-tail");
    expect(host.submissions[0]?.command.runtimeMode).toBe("full-access");
    expect(
      (await call("f5_thread_list", { projectId: "private" }, threadsSchema)).threads[0]?.id,
    ).toBe("existing");
    expect((await readCliThread(call, "existing", 10)).messages[0]?.text).toBe(text);
    expect(
      (await call("f5_thread_read", { threadId: "existing", messages: 0 }, readSchema)).messages,
    ).toEqual([]);
  });
});

it("bounds wire pages and reassembles stable full transcripts while new messages arrive", async () => {
  const { dir, host } = await setup();
  const messages = Array.from({ length: 45 }, (_, index) => ({
    id: MessageId.makeUnsafe("message-" + index),
    role: "assistant" as const,
    text: String(index) + "\n" + "🦊".repeat(6000),
    turnId: null,
    streaming: false,
    attachments: [],
    createdAt: "",
    updatedAt: "",
  }));
  host.threads = [thread("large", "private", { messages })];
  await withThreadClient(dir, async (call) => {
    const first = await call("f5_thread_read", { threadId: "large", messages: 45 }, readSchema);
    expect(first.messages).toHaveLength(20);
    expect(Buffer.byteLength(JSON.stringify(first))).toBeLessThan(1024 * 1024);
    expect(first.messages[0]?.nextTextOffset).not.toBeNull();
    let appended = false;
    const arriving: ToolCall = async (tool, args, schema) => {
      const result = await call(tool, args, schema);
      if (!appended) {
        appended = true;
        host.threads[0] = {
          ...host.threads[0]!,
          messages: [
            ...messages,
            { ...messages[0]!, id: MessageId.makeUnsafe("new-message"), text: "new" },
          ],
        };
      }
      return result;
    };
    const complete = await readCliThread(arriving, "large", 45);
    expect(complete.messages.map((m) => m.text)).toEqual(messages.map((m) => m.text));
  });
});

it("wait returns the submitted turn's reply even when a later turn needs input", async () => {
  const { dir, host } = await setup();
  const turnId = TurnId.makeUnsafe("old-turn");
  host.threads = [
    thread("existing", "private", {
      pendingUserInputs: [{}] as never,
      messages: [
        {
          id: MessageId.makeUnsafe("input"),
          role: "user",
          text: "question",
          turnId,
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
          attachments: [],
          streaming: false,
        },
        {
          id: MessageId.makeUnsafe("reply"),
          role: "assistant",
          text: "correct reply",
          turnId,
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
          attachments: [],
          streaming: false,
        },
      ],
    }),
  ];
  host.records.set("submission", {
    submissionId: CommandId.makeUnsafe("submission"),
    threadId: ThreadId.makeUnsafe("existing"),
    requestHash: "",
    itemId: null,
    messageId: "input",
    disposition: "started",
    resultSequence: 1,
    reasonCode: null,
    createdAt: "",
    settledAt: "",
  });
  host.turnStates.set(turnId, "completed");
  await withThreadClient(dir, async (call) => {
    const result = await call(
      "f5_thread_wait",
      { threadId: "existing", submissionId: "submission" },
      waitSchema,
    );
    expect(result).toMatchObject({ status: "completed", timedOut: false, reply: "correct reply" });
    await expect(
      call("f5_thread_wait", { threadId: "existing", submissionId: "missing" }, waitSchema),
    ).rejects.toThrow("Submission not found");
  });
});

it("bootstrap cannot call owner tools and temporary credentials are revoked on success and failure", async () => {
  const { dir, listener } = await setup();
  const credentials = (await readAgentBridgeLocalCredentials(ownerCredentialsPath(dir)))!;
  if (process.platform !== "win32")
    expect((await FS.stat(ownerCredentialsPath(dir))).mode & 0o777).toBe(0o600);
  const rpc = async (token: string, name: string) =>
    fetch("http://127.0.0.1:" + listener.port + "/mcp", {
      method: "POST",
      headers: { authorization: "Bearer " + token, "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name, arguments: {} },
      }),
    });
  const denied = await (await rpc(credentials.token, "f5_project_list")).json();
  expect(
    z.object({ result: z.object({ isError: z.boolean() }) }).parse(denied).result.isError,
  ).toBe(true);
  for (const shouldFail of [false, true]) {
    let sessionToken = "";
    const originalFetch = globalThis.fetch;
    const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
      const response = await originalFetch(url, init);
      if (String(init?.body).includes("f5_cli_open")) {
        sessionToken = z
          .object({ result: z.object({ structuredContent: z.object({ token: z.string() }) }) })
          .parse(await response.clone().json()).result.structuredContent.token;
      }
      return response;
    });
    const work = withThreadClient(dir, async () => {
      if (shouldFail) throw new Error("failed");
    });
    if (shouldFail) await expect(work).rejects.toThrow("failed");
    else await work;
    spy.mockRestore();
    expect(sessionToken).not.toBe("");
    const revoked = await rpc(sessionToken, "f5_project_list");
    expect(revoked.status).toBe(401);
    await revoked.body?.cancel();
  }
});

it("resolves the deepest project through symlinks and rejects sibling path prefixes", async () => {
  const { dir } = await setup();
  await FS.mkdir(Path.join(dir, "nested"));
  await FS.symlink(Path.join(dir, "nested"), Path.join(dir, "link"), "junction");
  const roots = [
    { id: "root", workspaceRoot: dir },
    { id: "nested", workspaceRoot: Path.join(dir, "nested") },
  ];
  expect((await resolveCliProject(roots, Path.join(dir, "link"))).id).toBe("nested");
  expect((await resolveCliProject(roots, "root")).id).toBe("root");
  await expect(resolveCliProject(roots, dir + "-sibling")).rejects.toThrow("No F5 project");
});

it("expires abandoned identities and prevents an active identity from minting another", async () => {
  const { dir } = await setup();
  await withThreadClient(dir, async (call) => {
    await expect(call("f5_cli_open", {}, sessionSchema)).rejects.toThrow(
      "Not a bootstrap credential",
    );
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now + 6 * 60_000);
    await expect(call("f5_project_list", {}, projectsSchema)).rejects.toThrow("HTTP 401");
  });
});

it("wait follows timeouts and sets distinct exit codes while preserving JSON thread ids", async () => {
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  for (const [status, code] of [
    ["completed", 0],
    ["waiting", 2],
    ["failed", 1],
    ["blocked", 1],
  ] as const) {
    process.exitCode = 0;
    const responses = [
      { threadId: "t", submissionId: "s", status: "running", timedOut: true, reply: null },
      {
        threadId: "t",
        submissionId: "s",
        status,
        timedOut: false,
        reply: status === "completed" ? "answer" : null,
      },
    ];
    const call: ToolCall = async (_tool, _args, schema) => schema.parse(responses.shift());
    await finishCliSubmission(call, { threadId: "t", submissionId: "s" }, true);
    expect(process.exitCode).toBe(code);
    expect(JSON.parse(log.mock.calls.at(-1)![0])).toMatchObject({ threadId: "t", status });
  }
  await expect(readCliMessage("   ")).rejects.toThrow("empty");
  expect(await readCliMessage("hello\nworld")).toBe("hello\nworld");
});
