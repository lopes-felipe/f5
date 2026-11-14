import * as FS from "node:fs/promises";
import * as OS from "node:os";
import * as Path from "node:path";
import { spawn } from "node:child_process";
import { afterEach, expect, it, vi } from "vitest";
import { z } from "zod";
import { CommandId, MessageId, ProviderInstanceId, ThreadId, TurnId } from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import { FakeAgentBridgeHost, project, thread } from "../agentBridge/testing/fakeHost.ts";
import { readAgentBridgeLocalCredentials } from "../agentBridge/localCredentials.ts";
import { startThreadCliListener } from "./listener.ts";
import { withThreadClient, resolveCliProject, type ToolCall } from "./client.ts";
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
    expect(
      (await call("f5_thread_read", { threadId: "existing" }, readSchema)).messages[0]?.text,
    ).toBe(text);
    expect(
      (await call("f5_thread_read", { threadId: "existing", messages: 0 }, readSchema)).messages,
    ).toEqual([]);
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
