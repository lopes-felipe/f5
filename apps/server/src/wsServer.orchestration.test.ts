import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  AGENT_BRIDGE_WS_METHODS,
  NATIVE_OPERATION_WS_METHODS,
  BOOTSTRAP_THREAD_NOT_CREATED_ERROR_CODE,
  defaultInstanceIdForDriver,
  ORCHESTRATION_WS_CHANNELS,
  ORCHESTRATION_WS_METHODS,
  PROVIDER_SEND_TURN_MAX_INPUT_CHARS,
  ProviderDriverKind,
  ProviderInstanceId,
  WS_METHODS,
  type OrchestrationReadModel,
  type ProviderRuntimeEvent,
  type WorktreeSetupSnapshot,
} from "@t3tools/contracts";
import { Effect, Layer, PubSub, Stream } from "effect";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { AGENT_BRIDGE_LISTENER_AVAILABLE } from "./agentBridge/AgentBridgeService.ts";
import { runAgentBridgeStdio } from "./agentBridge/stdioShim.ts";
import { makeSqlitePersistenceLive } from "./persistence/Layers/Sqlite";
import type { ProviderInstance } from "./provider/ProviderDriver.ts";
import { ProviderInstanceRegistry } from "./provider/Services/ProviderInstanceRegistry.ts";
import { ProviderService, type ProviderServiceShape } from "./provider/Services/ProviderService";
import { type TerminalManagerShape } from "./terminal/Services/Manager";
import {
  emptyAccountSection,
  makeAccountUsageCapability,
} from "./usage/Layers/AccountUsageService.ts";
import {
  asEventId,
  asProviderItemId,
  asThreadId,
  asTurnId,
  connectAndAwaitWelcome,
  createWsServerTestHarness,
  defaultProviderSnapshots,
  defaultProviderService,
  unsupportedProviderCall,
  MockTerminalManager,
  sendRequest,
  waitForPush,
} from "./wsServer.testHarness.ts";

describe("WebSocket Server", () => {
  const h = createWsServerTestHarness();
  const {
    connections,
    makeTempDir,
    makeTurnCapturingProviderService,
    createTestServer,
    closeTestServer,
  } = h;

  it("returns error when requesting turn diff for unknown thread", async () => {
    h.server = await createTestServer({ cwd: "/test" });
    const addr = h.server.address();
    const port = typeof addr === "object" && addr !== null ? addr.port : 0;

    const [ws] = await connectAndAwaitWelcome(port);
    connections.push(ws);

    const response = await sendRequest(ws, ORCHESTRATION_WS_METHODS.getTurnDiff, {
      threadId: "thread-missing",
      fromTurnCount: 1,
      toTurnCount: 2,
    });
    expect(response.result).toBeUndefined();
    expect(response.error?.message).toContain("Thread 'thread-missing' not found.");
  });

  it("returns error when requesting turn diff with an inverted range", async () => {
    h.server = await createTestServer({ cwd: "/test" });
    const addr = h.server.address();
    const port = typeof addr === "object" && addr !== null ? addr.port : 0;

    const [ws] = await connectAndAwaitWelcome(port);
    connections.push(ws);

    const response = await sendRequest(ws, ORCHESTRATION_WS_METHODS.getTurnDiff, {
      threadId: "thread-any",
      fromTurnCount: 2,
      toTurnCount: 1,
    });
    expect(response.result).toBeUndefined();
    expect(response.error?.message).toContain(
      "fromTurnCount must be less than or equal to toTurnCount",
    );
  });

  it("returns error when requesting full thread diff for unknown thread", async () => {
    h.server = await createTestServer({ cwd: "/test" });
    const addr = h.server.address();
    const port = typeof addr === "object" && addr !== null ? addr.port : 0;

    const [ws] = await connectAndAwaitWelcome(port);
    connections.push(ws);

    const response = await sendRequest(ws, ORCHESTRATION_WS_METHODS.getFullThreadDiff, {
      threadId: "thread-missing",
      toTurnCount: 2,
    });
    expect(response.result).toBeUndefined();
    expect(response.error?.message).toContain("Thread 'thread-missing' not found.");
  });

  it("returns retryable error when requested turn exceeds current checkpoint turn count", async () => {
    h.server = await createTestServer({ cwd: "/test" });
    const addr = h.server.address();
    const port = typeof addr === "object" && addr !== null ? addr.port : 0;

    const [ws] = await connectAndAwaitWelcome(port);
    connections.push(ws);

    const workspaceRoot = makeTempDir("t3code-ws-diff-project-");
    const createdAt = new Date().toISOString();
    const createProjectResponse = await sendRequest(ws, ORCHESTRATION_WS_METHODS.dispatchCommand, {
      type: "project.create",
      commandId: "cmd-diff-project-create",
      projectId: "project-diff",
      title: "Diff Project",
      workspaceRoot,
      defaultModel: "gpt-5-codex",
      createdAt,
    });
    expect(createProjectResponse.error).toBeUndefined();
    const createThreadResponse = await sendRequest(ws, ORCHESTRATION_WS_METHODS.dispatchCommand, {
      type: "thread.create",
      commandId: "cmd-diff-thread-create",
      threadId: "thread-diff",
      projectId: "project-diff",
      title: "Diff Thread",
      model: "gpt-5-codex",
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdAt,
    });
    expect(createThreadResponse.error).toBeUndefined();

    const response = await sendRequest(ws, ORCHESTRATION_WS_METHODS.getTurnDiff, {
      threadId: "thread-diff",
      fromTurnCount: 0,
      toTurnCount: 1,
    });
    expect(response.result).toBeUndefined();
    expect(response.error?.message).toContain("exceeds current turn count");
  });

  it("rejects oversized turn-start messages before dispatching orchestration events", async () => {
    h.server = await createTestServer({ cwd: "/test" });
    const addr = h.server.address();
    const port = typeof addr === "object" && addr !== null ? addr.port : 0;

    const [ws] = await connectAndAwaitWelcome(port);
    connections.push(ws);

    const workspaceRoot = makeTempDir("t3code-ws-oversized-project-");
    const createdAt = new Date().toISOString();
    const createProjectResponse = await sendRequest(ws, ORCHESTRATION_WS_METHODS.dispatchCommand, {
      type: "project.create",
      commandId: "cmd-oversized-project-create",
      projectId: "project-oversized",
      title: "Oversized Project",
      workspaceRoot,
      defaultModel: "gpt-5-codex",
      createdAt,
    });
    expect(createProjectResponse.error).toBeUndefined();
    const createThreadResponse = await sendRequest(ws, ORCHESTRATION_WS_METHODS.dispatchCommand, {
      type: "thread.create",
      commandId: "cmd-oversized-thread-create",
      threadId: "thread-oversized",
      projectId: "project-oversized",
      title: "Oversized Thread",
      model: "gpt-5-codex",
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdAt,
    });
    expect(createThreadResponse.error).toBeUndefined();

    const response = await sendRequest(ws, ORCHESTRATION_WS_METHODS.dispatchCommand, {
      type: "thread.turn.start",
      commandId: "cmd-oversized-turn-start",
      threadId: "thread-oversized",
      message: {
        messageId: "msg-oversized",
        role: "user",
        text: "x".repeat(PROVIDER_SEND_TURN_MAX_INPUT_CHARS + 1),
        attachments: [],
      },
      assistantDeliveryMode: "streaming",
      runtimeMode: "full-access",
      interactionMode: "default",
      createdAt,
    });

    expect(response.result).toBeUndefined();
    expect(response.error?.message).toContain("120,000 character provider input limit");
    expect(response.error?.message.length).toBeLessThan(240);

    const snapshotResponse = await sendRequest(ws, ORCHESTRATION_WS_METHODS.getSnapshot);
    const snapshot = snapshotResponse.result as OrchestrationReadModel;
    const thread = snapshot.threads.find((entry) => entry.id === "thread-oversized");
    expect(thread?.messages).toEqual([]);
  });

  it("rejects established-thread turn starts that bypass queue admission", async () => {
    h.server = await createTestServer({ cwd: "/test" });
    const addr = h.server.address();
    const port = typeof addr === "object" && addr !== null ? addr.port : 0;
    const [ws] = await connectAndAwaitWelcome(port);
    connections.push(ws);

    const createdAt = new Date().toISOString();
    const workspaceRoot = makeTempDir("t3code-ws-queue-admission-");
    const projectResponse = await sendRequest(ws, ORCHESTRATION_WS_METHODS.dispatchCommand, {
      type: "project.create",
      commandId: "cmd-queue-admission-project",
      projectId: "project-queue-admission",
      title: "Queue Admission",
      workspaceRoot,
      defaultModel: "gpt-5-codex",
      createdAt,
    });
    expect(projectResponse.error).toBeUndefined();
    const threadResponse = await sendRequest(ws, ORCHESTRATION_WS_METHODS.dispatchCommand, {
      type: "thread.create",
      commandId: "cmd-queue-admission-thread",
      threadId: "thread-queue-admission",
      projectId: "project-queue-admission",
      title: "Queue Admission",
      model: "gpt-5-codex",
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdAt,
    });
    expect(threadResponse.error).toBeUndefined();

    const response = await sendRequest(ws, ORCHESTRATION_WS_METHODS.dispatchCommand, {
      type: "thread.turn.start",
      commandId: "cmd-queue-admission-turn",
      dispatchSource: "next-turn-queue",
      threadId: "thread-queue-admission",
      message: {
        messageId: "message-queue-admission-turn",
        role: "user",
        text: "must go through the queue",
        attachments: [],
      },
      assistantDeliveryMode: "streaming",
      runtimeMode: "full-access",
      interactionMode: "default",
      createdAt,
    });

    expect(response.result).toBeUndefined();
    expect(response.error).toEqual(
      expect.objectContaining({
        code: "NextTurnQueueAdmissionRequired",
        message: expect.stringContaining("nextTurnQueue.submit"),
      }),
    );
  });

  it.each([
    ["text plus image", "Describe this image.", "text-image"],
    [
      "image-only fallback",
      "[User attached one or more images without additional text. Respond using the conversation context and the attached image(s).]",
      "image-only",
    ],
  ])("accepts a bootstrap first turn with %s", async (_caseName, messageText, suffix) => {
    const stateDir = makeTempDir(`t3code-ws-bootstrap-attachment-${suffix}-`);
    const workspaceRoot = makeTempDir(`t3code-ws-bootstrap-attachment-workspace-${suffix}-`);
    const dbPath = path.join(stateDir, "state.sqlite");
    const persistenceLayer = makeSqlitePersistenceLive(dbPath).pipe(
      Layer.provide(NodeServices.layer),
    );
    const sentTurns: Array<Parameters<ProviderServiceShape["sendTurn"]>[0]> = [];
    h.server = await createTestServer({
      cwd: workspaceRoot,
      persistenceLayer,
      providerLayer: Layer.succeed(ProviderService, makeTurnCapturingProviderService(sentTurns)),
      stateDir,
    });
    const addr = h.server.address();
    const port = typeof addr === "object" && addr !== null ? addr.port : 0;
    const [ws] = await connectAndAwaitWelcome(port);
    connections.push(ws);
    const createdAt = new Date().toISOString();
    const projectId = `project-bootstrap-attachment-${suffix}`;
    const threadId = `thread-bootstrap-attachment-${suffix}`;
    const messageId = `message-bootstrap-attachment-${suffix}`;

    const projectResponse = await sendRequest(ws, ORCHESTRATION_WS_METHODS.dispatchCommand, {
      type: "project.create",
      commandId: `command-bootstrap-attachment-project-${suffix}`,
      projectId,
      title: "Bootstrap Attachment",
      workspaceRoot,
      defaultModel: "gpt-5-codex",
      createdAt,
    });
    expect(projectResponse.error).toBeUndefined();

    const response = await sendRequest(ws, ORCHESTRATION_WS_METHODS.dispatchCommand, {
      type: "thread.turn.start",
      commandId: `command-bootstrap-attachment-turn-${suffix}`,
      threadId,
      message: {
        messageId,
        role: "user",
        text: messageText,
        attachments: [
          {
            type: "image",
            name: "first-image.png",
            mimeType: "image/png",
            sizeBytes: 5,
            dataUrl: "data:image/png;base64,aGVsbG8=",
          },
        ],
      },
      provider: "codex",
      assistantDeliveryMode: "streaming",
      runtimeMode: "full-access",
      interactionMode: "default",
      bootstrap: {
        createThread: {
          projectId,
          title: "New thread",
          model: "gpt-5-codex",
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdAt,
        },
      },
      createdAt,
    });
    expect(response.error).toBeUndefined();

    const snapshotResponse = await sendRequest(ws, ORCHESTRATION_WS_METHODS.getSnapshot);
    const snapshot = snapshotResponse.result as OrchestrationReadModel;
    const thread = snapshot.threads.find((entry) => entry.id === threadId);
    const message = thread?.messages.find((entry) => entry.id === messageId);
    expect(message).toEqual(
      expect.objectContaining({
        text: messageText,
        attachments: [
          expect.objectContaining({
            type: "image",
            name: "first-image.png",
            mimeType: "image/png",
            sizeBytes: 5,
          }),
        ],
      }),
    );
    const attachmentId = message?.attachments?.[0]?.id;
    expect(attachmentId).toBeTruthy();
    if (!attachmentId) {
      throw new Error("Expected the bootstrap message attachment to have an id.");
    }
    expect(fs.existsSync(path.join(stateDir, "attachments", `${attachmentId}.png`))).toBe(true);

    const database = new DatabaseSync(dbPath, { readOnly: true });
    try {
      expect(
        database
          .prepare("SELECT lifecycle FROM attachments WHERE attachment_id = ?")
          .get(attachmentId),
      ).toEqual({ lifecycle: "ready" });
      expect(
        database
          .prepare(
            "SELECT owner_kind AS ownerKind, owner_id AS ownerId FROM attachment_owners WHERE attachment_id = ?",
          )
          .get(attachmentId),
      ).toEqual({ ownerKind: "message", ownerId: messageId });
    } finally {
      database.close();
    }

    await vi.waitFor(() => expect(sentTurns).toHaveLength(1));
    expect(sentTurns[0]).toEqual(
      expect.objectContaining({
        threadId,
        attachments: [expect.objectContaining({ id: attachmentId, name: "first-image.png" })],
      }),
    );
  });

  // Each case starts one or two real servers and real Git worktrees, which can
  // exceed the 15 s default on loaded CI runners.
  describe("Agent Bridge", { timeout: 90_000 }, () => {
    const SLOW_WAIT = { timeout: 30_000 } as const;

    function makeBridgeRepo(): string {
      const repo = makeTempDir("f5-agent-bridge-repo-");
      const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, stdio: "pipe" });
      git("init", "--initial-branch=main");
      git("config", "user.email", "test@example.com");
      git("config", "user.name", "Test");
      fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
      git("add", ".");
      git("commit", "-m", "init");
      return repo;
    }

    async function bridgeRequest(stateDir: string, method: string, params?: unknown) {
      const credentials = JSON.parse(
        fs.readFileSync(path.join(stateDir, "agent-bridge", "local.json"), "utf8"),
      ) as { port: number; token: string };
      const response = await fetch(`http://127.0.0.1:${credentials.port}/mcp`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${credentials.token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      });
      return (await response.json()) as { result?: any; error?: { message: string } };
    }

    const callTool = async (stateDir: string, name: string, args: Record<string, unknown>) =>
      (await bridgeRequest(stateDir, "tools/call", { name, arguments: args })).result as {
        structuredContent: any;
        isError?: boolean;
      };

    const readProvenance = (dbPath: string) => {
      const db = new DatabaseSync(dbPath, { readOnly: true });
      try {
        return db
          .prepare("SELECT command_id, source FROM provider_submission_provenance")
          .all() as Array<{ command_id: string; source: string }>;
      } finally {
        db.close();
      }
    };

    // #148 shelved the listener; this test re-enables itself when the flag flips.
    it.skipIf(!AGENT_BRIDGE_LISTENER_AVAILABLE)(
      "admits supervised automation turns idempotently and keeps the WS route human",
      async () => {
        const repo = makeBridgeRepo();
        const stateDir = makeTempDir("f5-agent-bridge-state-");
        const dbPath = path.join(stateDir, "state.sqlite");
        const sentTurns: Array<Parameters<ProviderServiceShape["sendTurn"]>[0]> = [];
        h.server = await createTestServer({
          cwd: repo,
          stateDir,
          persistenceLayer: makeSqlitePersistenceLive(dbPath).pipe(
            Layer.provide(NodeServices.layer),
          ),
          providerLayer: Layer.succeed(
            ProviderService,
            makeTurnCapturingProviderService(sentTurns),
          ),
        });
        const addr = h.server.address();
        const [ws] = await connectAndAwaitWelcome(
          typeof addr === "object" && addr !== null ? addr.port : 0,
        );
        connections.push(ws);
        const createdAt = new Date().toISOString();
        await sendRequest(ws, ORCHESTRATION_WS_METHODS.dispatchCommand, {
          type: "project.create",
          commandId: "command-bridge-project",
          projectId: "project-bridge",
          title: "Bridge",
          workspaceRoot: repo,
          defaultModel: "gpt-5-codex",
          createdAt,
        });
        await sendRequest(ws, ORCHESTRATION_WS_METHODS.dispatchCommand, {
          type: "project.create",
          commandId: "command-hidden-project",
          projectId: "project-hidden",
          title: "Hidden",
          workspaceRoot: makeTempDir("f5-agent-bridge-hidden-"),
          defaultModel: "gpt-5-codex",
          createdAt,
        });
        const credentialsPath = path.join(stateDir, "agent-bridge", "local.json");
        expect(fs.existsSync(credentialsPath)).toBe(false);
        await sendRequest(ws, WS_METHODS.serverUpdateSettings, {
          agentBridge: { enabled: true, exposedProjectIds: ["project-bridge"] },
        });
        await vi.waitFor(() => expect(fs.existsSync(credentialsPath)).toBe(true), SLOW_WAIT);
        if (process.platform !== "win32")
          expect(fs.statSync(credentialsPath).mode & 0o777).toBe(0o600);

        const projects = await callTool(stateDir, "list_projects", {});
        expect(
          projects.structuredContent.projects.map((project: { id: string }) => project.id),
        ).toEqual(["project-bridge"]);
        const hidden = await callTool(stateDir, "create_thread", {
          projectId: "project-hidden",
          prompt: "No.",
        });
        expect(hidden.isError).toBe(true);
        expect(hidden.structuredContent.error).toBe("Project not found.");

        // Checkout bootstrap.
        const args = {
          projectId: "project-bridge",
          prompt: "Fix the README.",
          useWorktree: false,
          clientRequestId: "checkout-1",
        };
        const [first, concurrent] = await Promise.all([
          callTool(stateDir, "create_thread", args),
          callTool(stateDir, "create_thread", args),
        ]);
        expect(first.isError).toBeUndefined();
        expect(concurrent.structuredContent).toEqual(first.structuredContent);
        const { threadId, submissionId } = first.structuredContent;
        await vi.waitFor(() => expect(sentTurns).toHaveLength(1), SLOW_WAIT);
        expect(sentTurns[0]?.submissionSource).toBe("automation");
        const retry = await callTool(stateDir, "create_thread", args);
        expect(retry.structuredContent).toEqual(first.structuredContent);
        const conflict = await callTool(stateDir, "create_thread", { ...args, prompt: "Other." });
        expect(conflict.isError).toBe(true);

        let snapshot = (await sendRequest(ws, ORCHESTRATION_WS_METHODS.getSnapshot))
          .result as OrchestrationReadModel;
        const created = snapshot.threads.find((thread) => thread.id === threadId);
        expect(created?.runtimeMode).toBe("approval-required");
        await vi.waitFor(async () => {
          snapshot = (await sendRequest(ws, ORCHESTRATION_WS_METHODS.getSnapshot))
            .result as OrchestrationReadModel;
          expect(
            snapshot.threads
              .find((thread) => thread.id === threadId)
              ?.activities.filter((activity) => activity.kind === "agent-bridge.turn-submitted"),
          ).toHaveLength(1);
        }, SLOW_WAIT);

        // Worktree bootstrap.
        const worktree = await callTool(stateDir, "create_thread", {
          projectId: "project-bridge",
          prompt: "Work in a worktree.",
        });
        expect(worktree.structuredContent.disposition).toBe("queued");
        await vi.waitFor(() => expect(sentTurns).toHaveLength(2), SLOW_WAIT);
        expect(sentTurns[1]?.submissionSource).toBe("automation");

        // Existing-thread queueing; the first turn never settles, so it waits.
        const queued = await callTool(stateDir, "send_message", {
          threadId,
          prompt: "Also update the docs.",
        });
        expect(queued.structuredContent.disposition).toBe("queued");
        const waited = await callTool(stateDir, "wait_for_submission", {
          submissionId: queued.structuredContent.submissionId,
          timeoutSeconds: 0,
        });
        expect(waited.structuredContent).toMatchObject({ status: "queued", timedOut: true });

        // A human send on the WS route.
        await sendRequest(ws, WS_METHODS.nextTurnQueueSubmit, {
          submissionId: "human-submission",
          intent: "queue-tail",
          command: {
            type: "thread.turn.start",
            commandId: "human-submission",
            threadId,
            message: { messageId: "human-message", role: "user", text: "Me.", attachments: [] },
            runtimeMode: "approval-required",
            interactionMode: "default",
            createdAt: new Date().toISOString(),
          },
        });

        const provenance = new Map(
          readProvenance(dbPath).map((row) => [row.command_id, row.source] as const),
        );
        expect(provenance.get(submissionId)).toBe("automation");
        expect(provenance.get(worktree.structuredContent.submissionId)).toBe("automation");
        expect(provenance.get(queued.structuredContent.submissionId)).toBe("automation");
        expect(provenance.get("human-submission")).toBe("human");

        // Supervision: a full-access thread refuses bridge messages.
        await sendRequest(ws, ORCHESTRATION_WS_METHODS.dispatchCommand, {
          type: "thread.runtime-mode.set",
          commandId: "command-bridge-full-access",
          threadId,
          runtimeMode: "full-access",
          createdAt: new Date().toISOString(),
        });
        await vi.waitFor(async () => {
          const refused = await callTool(stateDir, "send_message", { threadId, prompt: "Again." });
          expect(refused.structuredContent.error).toContain("not supervised");
        }, SLOW_WAIT);

        await sendRequest(ws, WS_METHODS.serverUpdateSettings, {
          agentBridge: { enabled: false },
        });
        await vi.waitFor(() => expect(fs.existsSync(credentialsPath)).toBe(false), SLOW_WAIT);
      },
    );

    /** One tools/call through the STDIO shim, as a generic MCP client would. */
    async function shimCall(stateDir: string, name: string, args: Record<string, unknown>) {
      const input = new PassThrough();
      const output = new PassThrough();
      const chunks: string[] = [];
      output.on("data", (chunk: Buffer) => chunks.push(chunk.toString("utf8")));
      const done = runAgentBridgeStdio({
        credentialsPath: path.join(stateDir, "agent-bridge", "local.json"),
        input,
        output,
        env: {},
      });
      const messages = [
        { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } },
        { jsonrpc: "2.0", method: "notifications/initialized" },
        { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name, arguments: args } },
      ];
      for (const message of messages) input.write(`${JSON.stringify(message)}\n`);
      input.end();
      await done;
      const replies = chunks
        .join("")
        .split("\n")
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line) as { id?: number; result?: any });
      return replies.find((reply) => reply.id === 2)?.result as {
        structuredContent: any;
        isError?: boolean;
      };
    }

    // #148 shelved the listener; this test re-enables itself when the flag flips.
    it.skipIf(!AGENT_BRIDGE_LISTENER_AVAILABLE)(
      "runs a task lifecycle through the STDIO shim across a restart",
      async () => {
        const repo = makeBridgeRepo();
        const stateDir = makeTempDir("f5-agent-bridge-tasks-");
        const dbPath = path.join(stateDir, "state.sqlite");
        const start = async () => {
          h.server = await createTestServer({
            cwd: repo,
            stateDir,
            persistenceLayer: makeSqlitePersistenceLive(dbPath).pipe(
              Layer.provide(NodeServices.layer),
            ),
          });
          const addr = h.server.address();
          const [ws] = await connectAndAwaitWelcome(
            typeof addr === "object" && addr !== null ? addr.port : 0,
          );
          connections.push(ws);
          return ws;
        };
        let ws = await start();
        await sendRequest(ws, ORCHESTRATION_WS_METHODS.dispatchCommand, {
          type: "project.create",
          commandId: "command-task-project",
          projectId: "project-tasks",
          title: "Tasks",
          workspaceRoot: repo,
          defaultModel: "gpt-5-codex",
          createdAt: new Date().toISOString(),
        });
        await sendRequest(ws, WS_METHODS.serverUpdateSettings, {
          agentBridge: { enabled: true, exposedProjectIds: ["project-tasks"] },
        });
        const credentialsPath = path.join(stateDir, "agent-bridge", "local.json");
        await vi.waitFor(() => expect(fs.existsSync(credentialsPath)).toBe(true), SLOW_WAIT);

        const created = await sendRequest(ws, AGENT_BRIDGE_WS_METHODS.createTask, {
          operationId: "create-1",
          clientId: "local",
          projectId: "project-tasks",
          title: "Summarize",
          instructions: "Summarize the README.",
        });
        const taskId = (created.result as { id: string }).id;
        const listed = await shimCall(stateDir, "list_tasks", {});
        expect(
          listed.structuredContent.tasks.map((task: { taskId: string }) => task.taskId),
        ).toEqual([taskId]);
        const claimed = await shimCall(stateDir, "claim_task", { taskId, operationId: "claim-1" });
        const epoch = claimed.structuredContent.executionEpoch as number;
        expect(
          (
            await shimCall(stateDir, "report_task_progress", {
              taskId,
              executionEpoch: epoch,
              operationId: "progress-1",
              summary: "Reading",
            })
          ).isError,
        ).toBeUndefined();
        const asked = await shimCall(stateDir, "request_task_input", {
          taskId,
          executionEpoch: epoch,
          operationId: "question-1",
          question: "Short or long?",
        });
        const questionId = asked.structuredContent.questionId as string;

        // Restart: the task board and the revision survive.
        const revisionBefore = (
          (await sendRequest(ws, AGENT_BRIDGE_WS_METHODS.getTasks, {})).result as {
            revision: number;
          }
        ).revision;
        for (const socket of connections.splice(0)) socket.close();
        await closeTestServer();
        ws = await start();
        await vi.waitFor(() => expect(fs.existsSync(credentialsPath)).toBe(true), SLOW_WAIT);
        const afterRestart = (await sendRequest(ws, AGENT_BRIDGE_WS_METHODS.getTasks, {}))
          .result as {
          revision: number;
          tasks: Array<{ id: string; status: string; version: number }>;
        };
        expect(afterRestart.revision).toBe(revisionBefore);
        const waiting = afterRestart.tasks.find((task) => task.id === taskId);
        expect(waiting?.status).toBe("waiting-for-user");

        await sendRequest(ws, AGENT_BRIDGE_WS_METHODS.replyToTask, {
          operationId: "reply-1",
          taskId,
          questionId,
          expectedVersion: waiting?.version,
          text: "Short.",
        });
        const read = await shimCall(stateDir, "get_task", { taskId });
        expect(read.structuredContent.status).toBe("running");
        expect(
          read.structuredContent.history.find((entry: { type: string }) => entry.type === "reply")
            ?.content,
        ).toBe("Short.");
        const completed = await shimCall(stateDir, "complete_task", {
          taskId,
          executionEpoch: epoch,
          operationId: "complete-1",
          result: "It says hello.",
        });
        expect(completed.isError).toBeUndefined();
        const final = (await sendRequest(ws, AGENT_BRIDGE_WS_METHODS.getTask, { taskId }))
          .result as {
          status: string;
          result: string;
        };
        expect(final).toMatchObject({ status: "completed", result: "It says hello." });
        const activities = (
          (await sendRequest(ws, AGENT_BRIDGE_WS_METHODS.getTaskActivities, { taskId })).result as {
            activities: Array<{ type: string }>;
          }
        ).activities.map((activity) => activity.type);
        expect(activities).toEqual([
          "completed",
          "reply",
          "question",
          "progress",
          "claimed",
          "created",
        ]);
      },
    );
  });

  describe("first sends through nextTurnQueue.submit", { timeout: 90_000 }, () => {
    /** How long to wait for background setup or a turn on a slow runner. */
    const SLOW_WAIT = { timeout: 30_000 } as const;
    function nodeSetupCommand(script: string): string {
      return `"${process.execPath}" -e "${script}"`;
    }

    function makeGitRepo(prefix: string): string {
      const repo = makeTempDir(prefix);
      const git = (...args: string[]) =>
        execFileSync("git", args, { cwd: repo, stdio: "pipe" }).toString().trim();
      git("init", "--initial-branch=main");
      git("config", "user.email", "test@example.com");
      git("config", "user.name", "Test");
      fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
      git("add", ".");
      git("commit", "-m", "init");
      return repo;
    }

    class RecordingTerminalManager extends MockTerminalManager {
      readonly opened: Array<{ terminalId: string; cwd: string }> = [];
      constructor() {
        super();
        const baseOpen = this.open;
        (this as { open: TerminalManagerShape["open"] }).open = (input) => {
          this.opened.push({ terminalId: input.terminalId ?? "default", cwd: input.cwd });
          return baseOpen(input);
        };
      }
    }

    type Variant = {
      readonly name: string;
      readonly worktree: boolean;
      readonly setupScript: boolean;
    };
    const variants: ReadonlyArray<Variant> = [
      { name: "create-thread only", worktree: false, setupScript: false },
      {
        name: "create-thread with a setup script but no worktree",
        worktree: false,
        setupScript: true,
      },
      { name: "create-thread and prepare-worktree", worktree: true, setupScript: false },
      {
        name: "create-thread, prepare-worktree and run-setup-script",
        worktree: true,
        setupScript: true,
      },
    ];

    async function readSetup(ws: WebSocket, threadId: string) {
      return (
        (await sendRequest(ws, WS_METHODS.worktreeSetupSubscribe, { threadId })).result as {
          snapshot: WorktreeSetupSnapshot | null;
        }
      ).snapshot;
    }

    async function sendSetupAction(ws: WebSocket, method: string, input: { threadId: string }) {
      const snapshot = await readSetup(ws, input.threadId);
      return sendRequest(ws, method, {
        ...input,
        expectedOperationId: snapshot?.operationId ?? "missing",
      });
    }

    async function waitForSetup(
      ws: WebSocket,
      threadId: string,
      predicate: (snapshot: WorktreeSetupSnapshot | null) => boolean,
      timeoutMs = SLOW_WAIT.timeout,
    ): Promise<WorktreeSetupSnapshot | null> {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const snapshot = await readSetup(ws, threadId);
        if (predicate(snapshot)) return snapshot;
        if (Date.now() > deadline) {
          throw new Error(`Worktree setup did not settle: ${JSON.stringify(snapshot)}`);
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }

    async function runFirstSend(route: "dispatch" | "submit", variant: Variant) {
      const stateDir = makeTempDir(`t3code-ws-first-send-${route}-`);
      const repo = makeGitRepo(`t3code-ws-first-send-repo-${route}-`);
      const sentTurns: Array<Parameters<ProviderServiceShape["sendTurn"]>[0]> = [];
      const terminalManager = new RecordingTerminalManager();
      h.server = await createTestServer({
        cwd: repo,
        stateDir,
        providerLayer: Layer.succeed(ProviderService, makeTurnCapturingProviderService(sentTurns)),
        terminalManager,
      });
      const addr = h.server.address();
      const port = typeof addr === "object" && addr !== null ? addr.port : 0;
      const [ws] = await connectAndAwaitWelcome(port);
      connections.push(ws);
      const createdAt = "2026-10-01T00:00:00.000Z";
      const projectId = "project-first-send";
      const threadId = "thread-first-send";
      expect(
        (
          await sendRequest(ws, ORCHESTRATION_WS_METHODS.dispatchCommand, {
            type: "project.create",
            commandId: "command-first-send-project",
            projectId,
            title: "First send",
            workspaceRoot: repo,
            defaultModel: "gpt-5-codex",
            createdAt,
          })
        ).error,
      ).toBeUndefined();
      if (variant.setupScript) {
        expect(
          (
            await sendRequest(ws, ORCHESTRATION_WS_METHODS.dispatchCommand, {
              type: "project.meta.update",
              commandId: "command-first-send-scripts",
              projectId,
              scripts: [
                {
                  id: "setup",
                  name: "Setup",
                  command: "echo setup",
                  icon: "play",
                  runOnWorktreeCreate: true,
                },
              ],
            })
          ).error,
        ).toBeUndefined();
      }
      const command = {
        type: "thread.turn.start",
        commandId: "command-first-send-turn",
        threadId,
        message: {
          messageId: "message-first-send",
          role: "user",
          text: "Start here.",
          attachments: [],
        },
        provider: "codex",
        assistantDeliveryMode: "streaming",
        runtimeMode: "full-access",
        interactionMode: "default",
        bootstrap: {
          createThread: {
            projectId,
            title: "New thread",
            model: "gpt-5-codex",
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: variant.worktree ? null : "main",
            worktreePath: null,
            createdAt,
          },
          ...(variant.worktree
            ? { prepareWorktree: { projectCwd: repo, baseBranch: "main", branch: "f5/first-send" } }
            : {}),
          ...(variant.setupScript ? { runSetupScript: true } : {}),
        },
        createdAt,
      };
      const response =
        route === "dispatch"
          ? await sendRequest(ws, ORCHESTRATION_WS_METHODS.dispatchCommand, command)
          : await sendRequest(ws, WS_METHODS.nextTurnQueueSubmit, {
              submissionId: "command-first-send-turn",
              command,
              intent: "auto",
            });
      expect(response.error).toBeUndefined();
      await vi.waitFor(() => expect(sentTurns).toHaveLength(1), SLOW_WAIT);
      const snapshot = (await sendRequest(ws, ORCHESTRATION_WS_METHODS.getSnapshot))
        .result as OrchestrationReadModel;
      const thread = snapshot.threads.find((entry) => entry.id === threadId);
      const relative = (value: string | null | undefined) => {
        if (value == null) return null;
        // Resolve short Windows temp paths and separators before comparing routes.
        const canonicalValue = fs.realpathSync.native(value);
        const canonicalWorktreesDir = path.join(
          fs.realpathSync.native(path.dirname(stateDir)),
          "worktrees",
        );
        const relativePath = path.relative(canonicalWorktreesDir, canonicalValue);
        return relativePath !== "" &&
          relativePath !== ".." &&
          !relativePath.startsWith(`..${path.sep}`) &&
          !path.isAbsolute(relativePath)
          ? `<worktrees>/<repo>/${path.basename(canonicalValue)}`
          : canonicalValue === fs.realpathSync.native(repo)
            ? "<repo>"
            : value;
      };
      const outcome = {
        // The title is left out: it is renamed later by title generation, whose
        // timing depends on the environment and not on the bootstrap route.
        branch: thread?.branch,
        worktreePath: relative(thread?.worktreePath),
        worktreeExists: thread?.worktreePath ? fs.existsSync(thread.worktreePath) : null,
        messages: thread?.messages.map((message) => ({ role: message.role, text: message.text })),
        terminals: terminalManager.opened.map((entry) => ({
          terminalId: entry.terminalId,
          cwd: relative(entry.cwd),
        })),
        sentTurnThread: sentTurns[0]?.threadId,
      };
      const setup = await waitForSetup(ws, threadId, (snapshot) => snapshot?.phase !== "running");
      for (const ws of connections.splice(0)) ws.close();
      await closeTestServer();
      h.server = null;
      return { outcome, result: response.result, setup };
    }

    it.each([false, true])(
      "scheduled first sends persist identities across restart (worktree=%s)",
      async (worktree) => {
        const stateDir = makeTempDir("f5-scheduled-submission-");
        const repo = makeGitRepo("f5-scheduled-submission-repo-");
        const sentTurns: Array<Parameters<ProviderServiceShape["sendTurn"]>[0]> = [];
        const accepted = Promise.withResolvers<void>();
        const capture = makeTurnCapturingProviderService(sentTurns);
        const start = async () => {
          h.server = await createTestServer({
            cwd: repo,
            stateDir,
            persistenceLayer: makeSqlitePersistenceLive(path.join(stateDir, "state.sqlite")).pipe(
              Layer.provide(NodeServices.layer),
            ),
            providerLayer: Layer.succeed(ProviderService, {
              ...capture,
              sendTurn: (input) =>
                capture
                  .sendTurn(input)
                  .pipe(Effect.tap(() => Effect.sync(() => accepted.resolve()))),
            }),
          });
          const address = h.server.address();
          const [ws] = await connectAndAwaitWelcome(
            typeof address === "object" && address ? address.port : 0,
          );
          connections.push(ws);
          return ws;
        };
        let ws = await start();
        const requestedAt = new Date().toISOString();
        expect(
          (
            await sendRequest(ws, ORCHESTRATION_WS_METHODS.dispatchCommand, {
              type: "project.create",
              commandId: crypto.randomUUID(),
              projectId: "scheduled-project",
              title: "Scheduled",
              workspaceRoot: repo,
              defaultModel: "gpt-5-codex",
              createdAt: requestedAt,
            })
          ).error,
        ).toBeUndefined();
        const definition = {
          id: crypto.randomUUID(),
          projectId: "scheduled-project",
          requestedAt,
          configuration: {
            name: "Scheduled integration",
            prompt: "One durable scheduled send.",
            modelSelection: { instanceId: "codex", model: "gpt-5-codex" },
            runtimeMode: "approval-required",
            workspace: worktree
              ? { kind: "worktree", baseBranch: "main" }
              : { kind: "projectRoot" },
            cron: "* * * * *",
            timezone: "UTC",
            scheduleSource: "cron",
            maxRuns: 1,
            oneShotAt: null,
            notify: "none",
            enabled: true,
          },
        };
        expect(
          (await sendRequest(ws, WS_METHODS.scheduledTasksCreate, definition)).error,
        ).toBeUndefined();
        const fire = { taskId: definition.id, runId: crypto.randomUUID(), requestedAt };
        expect(
          (await sendRequest(ws, WS_METHODS.scheduledTasksRunNow, fire)).error,
        ).toBeUndefined();
        await accepted.promise;
        expect(sentTurns).toHaveLength(1);
        const threadId = sentTurns[0]!.threadId;
        const snapshot = (await sendRequest(ws, ORCHESTRATION_WS_METHODS.getSnapshot))
          .result as OrchestrationReadModel;
        const thread = snapshot.threads.find((thread) => thread.id === threadId)!;
        expect(thread.scheduledOrigin).toEqual({ taskId: definition.id, runId: fire.runId });
        expect(Boolean(thread.worktreePath)).toBe(worktree);
        if (thread.worktreePath) expect(fs.existsSync(thread.worktreePath)).toBe(true);
        for (const connection of connections.splice(0)) connection.close();
        await closeTestServer();
        h.server = null;
        ws = await start();
        const replay = await sendRequest(ws, WS_METHODS.scheduledTasksRunNow, fire);
        expect(replay.error).toBeUndefined();
        expect(replay.result).toEqual(expect.objectContaining({ id: fire.runId, threadId }));
        const reopened = (await sendRequest(ws, ORCHESTRATION_WS_METHODS.getSnapshot))
          .result as OrchestrationReadModel;
        expect(
          reopened.threads.filter((thread) => thread.scheduledOrigin?.runId === fire.runId),
        ).toHaveLength(1);
        expect(sentTurns).toHaveLength(1);
        expect(
          (await sendRequest(ws, WS_METHODS.scheduledTasksCreate, definition)).error,
        ).toBeUndefined();
        const tasks = (await sendRequest(ws, WS_METHODS.scheduledTasksList, {})).result as {
          tasks: Array<{ task: { runsConsumed: number; enabled: boolean } }>;
        };
        expect(tasks.tasks[0]!.task.runsConsumed).toBe(1);
        expect(tasks.tasks[0]!.task.enabled).toBe(false);
      },
    );

    it.each(variants)("matches the direct dispatch route for $name", async (variant) => {
      const direct = await runFirstSend("dispatch", variant);
      const queued = await runFirstSend("submit", variant);
      // Worktree setup runs the script as an owned process instead of a terminal.
      expect({ ...queued.outcome, terminals: [] }).toEqual({ ...direct.outcome, terminals: [] });
      expect(direct.outcome.worktreeExists).toBe(variant.worktree ? true : null);
      expect(direct.outcome.terminals).toHaveLength(0);
      expect(queued.outcome.terminals).toHaveLength(0);
      if (variant.worktree) {
        // A worktree first send is queued behind its background setup.
        expect(queued.result).toEqual(
          expect.objectContaining({
            disposition: "queued",
            submissionId: "command-first-send-turn",
          }),
        );
        await vi.waitFor(() => expect(queued.setup).not.toBeNull(), SLOW_WAIT);
        expect(queued.setup?.stages.find((stage) => stage.id === "setup-script")?.status).toBe(
          variant.setupScript ? "done" : "skipped",
        );
      } else {
        expect(queued.result).toEqual(
          expect.objectContaining({
            disposition: "started",
            submissionId: "command-first-send-turn",
            sequence: expect.any(Number),
          }),
        );
        expect(queued.setup).toBeNull();
      }
    });

    it("replays a resubmitted first send instead of creating the thread twice", async () => {
      const stateDir = makeTempDir("t3code-ws-first-send-replay-");
      const repo = makeGitRepo("t3code-ws-first-send-replay-repo-");
      const sentTurns: Array<Parameters<ProviderServiceShape["sendTurn"]>[0]> = [];
      h.server = await createTestServer({
        cwd: repo,
        stateDir,
        providerLayer: Layer.succeed(ProviderService, makeTurnCapturingProviderService(sentTurns)),
      });
      const addr = h.server.address();
      const port = typeof addr === "object" && addr !== null ? addr.port : 0;
      const [ws] = await connectAndAwaitWelcome(port);
      connections.push(ws);
      const createdAt = new Date().toISOString();
      await sendRequest(ws, ORCHESTRATION_WS_METHODS.dispatchCommand, {
        type: "project.create",
        commandId: "command-replay-project",
        projectId: "project-replay",
        title: "Replay",
        workspaceRoot: repo,
        defaultModel: "gpt-5-codex",
        createdAt,
      });
      const submit = {
        submissionId: "submission-replay",
        intent: "auto",
        command: {
          type: "thread.turn.start",
          commandId: "submission-replay",
          threadId: "thread-replay",
          message: { messageId: "message-replay", role: "user", text: "Once.", attachments: [] },
          provider: "codex",
          assistantDeliveryMode: "streaming",
          runtimeMode: "full-access",
          interactionMode: "default",
          bootstrap: {
            createThread: {
              projectId: "project-replay",
              title: "New thread",
              model: "gpt-5-codex",
              runtimeMode: "full-access",
              interactionMode: "default",
              branch: null,
              worktreePath: null,
              createdAt,
            },
          },
          createdAt,
        },
      };
      // Two sockets: the test helper reads one response stream per socket.
      const [otherWs] = await connectAndAwaitWelcome(port);
      connections.push(otherWs);
      const [first, second] = await Promise.all([
        sendRequest(ws, WS_METHODS.nextTurnQueueSubmit, submit),
        sendRequest(otherWs, WS_METHODS.nextTurnQueueSubmit, submit),
      ]);
      const third = await sendRequest(ws, WS_METHODS.nextTurnQueueSubmit, submit);
      expect(first.error).toBeUndefined();
      expect(second.result).toEqual(first.result);
      expect(third.result).toEqual(first.result);
      await vi.waitFor(() => expect(sentTurns).toHaveLength(1), SLOW_WAIT);
      const snapshot = (await sendRequest(ws, ORCHESTRATION_WS_METHODS.getSnapshot))
        .result as OrchestrationReadModel;
      expect(snapshot.threads.filter((entry) => entry.id === "thread-replay")).toHaveLength(1);
      expect(snapshot.threads.find((entry) => entry.id === "thread-replay")?.messages).toHaveLength(
        1,
      );
    });

    describe("background worktree setup", () => {
      function addOriginRemote(repo: string): void {
        const bare = makeTempDir("t3code-ws-setup-origin-");
        execFileSync("git", ["init", "--bare", "--initial-branch=main", bare], { stdio: "pipe" });
        execFileSync("git", ["remote", "add", "origin", bare], { cwd: repo, stdio: "pipe" });
        execFileSync("git", ["push", "-u", "origin", "main"], { cwd: repo, stdio: "pipe" });
      }

      async function startServer(options: {
        readonly repo: string;
        readonly stateDir?: string;
        readonly persistenceLayer?: Parameters<typeof createTestServer>[0] extends infer O
          ? O extends { persistenceLayer?: infer P }
            ? P
            : never
          : never;
        readonly sentTurns: Array<Parameters<ProviderServiceShape["sendTurn"]>[0]>;
        readonly generateBranchName?: ProviderInstance["textGeneration"]["generateBranchName"];
      }) {
        h.server = await createTestServer({
          cwd: options.repo,
          ...(options.stateDir ? { stateDir: options.stateDir } : {}),
          ...(options.persistenceLayer ? { persistenceLayer: options.persistenceLayer } : {}),
          providerLayer: Layer.succeed(
            ProviderService,
            makeTurnCapturingProviderService(options.sentTurns),
          ),
          ...(options.generateBranchName
            ? {
                providerInstanceRegistryLayer: Layer.succeed(ProviderInstanceRegistry, {
                  getInstance: () =>
                    Effect.succeed({
                      instanceId: ProviderInstanceId.make("codex"),
                      enabled: true,
                      driverKind: ProviderDriverKind.make("codex"),
                      continuationIdentity: {
                        driverKind: ProviderDriverKind.make("codex"),
                        continuationKey: "codex",
                      },
                      displayName: undefined,
                      snapshot: {
                        getSnapshot: Effect.succeed(defaultProviderSnapshots[0]!),
                        refresh: Effect.succeed(defaultProviderSnapshots[0]!),
                        streamChanges: Stream.empty,
                      },
                      adapter: {} as ProviderInstance["adapter"],
                      textGeneration: {
                        generateBranchName: options.generateBranchName!,
                        generateCommitMessage: () => Effect.die("unused commit generation"),
                        generatePrContent: () => Effect.die("unused PR generation"),
                        generateStructuredJson: () => Effect.die("unused structured generation"),
                        generateThreadTitle: () => Effect.succeed({ title: "Generated title" }),
                      },
                    } as ProviderInstance),
                  listInstances: Effect.succeed([]),
                  listUnavailable: Effect.succeed([]),
                  streamChanges: Stream.empty,
                  subscribeChanges: Effect.acquireRelease(
                    PubSub.unbounded<void>(),
                    PubSub.shutdown,
                  ).pipe(Effect.flatMap(PubSub.subscribe)),
                }),
              }
            : {}),
        });
        const addr = h.server.address();
        const port = typeof addr === "object" && addr !== null ? addr.port : 0;
        const [ws] = await connectAndAwaitWelcome(port);
        connections.push(ws);
        return ws;
      }

      async function createProject(
        ws: WebSocket,
        repo: string,
        script?: { readonly command: string; readonly async?: boolean },
      ) {
        const createdAt = new Date().toISOString();
        await sendRequest(ws, ORCHESTRATION_WS_METHODS.dispatchCommand, {
          type: "project.create",
          commandId: `command-setup-project-${crypto.randomUUID()}`,
          projectId: "project-setup",
          title: "Setup",
          workspaceRoot: repo,
          defaultModel: "gpt-5-codex",
          createdAt,
        });
        if (script) {
          await sendRequest(ws, ORCHESTRATION_WS_METHODS.dispatchCommand, {
            type: "project.meta.update",
            commandId: `command-setup-scripts-${crypto.randomUUID()}`,
            projectId: "project-setup",
            scripts: [
              {
                id: "setup",
                name: "Setup",
                command: script.command,
                icon: "play",
                runOnWorktreeCreate: true,
                ...(script.async === undefined ? {} : { async: script.async }),
              },
            ],
          });
        }
      }

      function firstSend(input: {
        readonly repo: string;
        readonly threadId: string;
        readonly baseBranch?: string;
        readonly requireWorktree?: boolean;
      }) {
        const createdAt = new Date().toISOString();
        return {
          submissionId: `submission-${input.threadId}`,
          intent: "auto",
          command: {
            type: "thread.turn.start",
            commandId: `submission-${input.threadId}`,
            threadId: input.threadId,
            message: {
              messageId: `message-${input.threadId}`,
              role: "user",
              text: "Build it.",
              attachments: [],
            },
            provider: "codex",
            assistantDeliveryMode: "streaming",
            runtimeMode: "full-access",
            interactionMode: "default",
            bootstrap: {
              createThread: {
                projectId: "project-setup",
                title: "New thread",
                model: "gpt-5-codex",
                runtimeMode: "full-access",
                interactionMode: "default",
                branch: null,
                worktreePath: null,
                createdAt,
              },
              prepareWorktree: {
                projectCwd: input.repo,
                baseBranch: input.baseBranch ?? "main",
                branch: `f5/${input.threadId}`,
                ...(input.requireWorktree ? { requireWorktree: true } : {}),
              },
              runSetupScript: true,
            },
            createdAt,
          },
        };
      }

      const branchExists = (repo: string, branch: string) => {
        try {
          execFileSync("git", ["rev-parse", "--verify", `refs/heads/${branch}`], {
            cwd: repo,
            stdio: "pipe",
          });
          return true;
        } catch {
          return false;
        }
      };

      it("rejects a required worktree before creating the thread", async () => {
        const repo = makeTempDir("t3code-ws-setup-required-");
        const sentTurns: Array<Parameters<ProviderServiceShape["sendTurn"]>[0]> = [];
        const ws = await startServer({ repo, sentTurns });
        await createProject(ws, repo);
        const response = await sendRequest(
          ws,
          WS_METHODS.nextTurnQueueSubmit,
          firstSend({ repo, threadId: "thread-required", requireWorktree: true }),
        );
        expect(response.error).toEqual(
          expect.objectContaining({ code: BOOTSTRAP_THREAD_NOT_CREATED_ERROR_CODE }),
        );
        const snapshot = (await sendRequest(ws, ORCHESTRATION_WS_METHODS.getSnapshot))
          .result as OrchestrationReadModel;
        expect(snapshot.threads.some((entry) => entry.id === "thread-required")).toBe(false);
      });

      it.each([false, true])(
        "names before handoff and keeps the matching checkout path (late: %s)",
        async (late) => {
          const repo = makeGitRepo("f5-ws-generated-name-");
          const sentTurns: Array<Parameters<ProviderServiceShape["sendTurn"]>[0]> = [];
          const generateBranchName = vi.fn(() =>
            Effect.sleep(late ? "3100 millis" : "1 millis").pipe(
              Effect.as({ branch: "generated-worktree" }),
            ),
          );
          const ws = await startServer({ repo, sentTurns, generateBranchName });
          await createProject(
            ws,
            repo,
            late
              ? { command: nodeSetupCommand("setTimeout(() => {}, 1000)"), async: false }
              : undefined,
          );
          const base = firstSend({ repo, threadId: "generated-name" });
          const response = await sendRequest(ws, WS_METHODS.nextTurnQueueSubmit, {
            ...base,
            command: {
              ...base.command,
              bootstrap: {
                ...base.command.bootstrap,
                prepareWorktree: {
                  ...base.command.bootstrap.prepareWorktree,
                  branch: "t3code/11223344",
                },
              },
            },
          });
          expect(response.error).toBeUndefined();
          const done = await waitForSetup(
            ws,
            "generated-name",
            (snapshot) => snapshot?.phase === "done",
          );
          expect(done?.request.branch).toBe("f5/generated-worktree");
          expect(path.basename(done!.worktreePath!)).toMatch(
            late ? /^t3code-11223344-/ : /^f5-generated-worktree-/,
          );
          expect(
            execFileSync("git", ["branch", "--show-current"], {
              cwd: done!.worktreePath!,
              encoding: "utf8",
            }).trim(),
          ).toBe("f5/generated-worktree");
          await vi.waitFor(() => expect(sentTurns).toHaveLength(1), SLOW_WAIT);
          expect(generateBranchName).toHaveBeenCalledTimes(1);
        },
      );
      it("serializes identical late generated names across separate checkout paths", async () => {
        const repo = makeGitRepo("f5-ws-late-fanout-");
        const sentTurns: Array<Parameters<ProviderServiceShape["sendTurn"]>[0]> = [];
        const ws = await startServer({
          repo,
          sentTurns,
          generateBranchName: () =>
            Effect.sleep("3100 millis").pipe(Effect.as({ branch: "shared-title" })),
        });
        await createProject(ws, repo, {
          command: nodeSetupCommand("setTimeout(() => {}, 1000)"),
          async: false,
        });
        const address = h.server!.address();
        const port = typeof address === "object" && address !== null ? address.port : 0;
        const [secondClient] = await connectAndAwaitWelcome(port);
        connections.push(secondClient);
        const requests = ["late-one", "late-two"].map((threadId, index) => {
          const base = firstSend({ repo, threadId });
          return {
            ...base,
            command: {
              ...base.command,
              bootstrap: {
                ...base.command.bootstrap,
                prepareWorktree: {
                  ...base.command.bootstrap.prepareWorktree,
                  branch: `t3code/1234aa1${index}`,
                },
              },
            },
          };
        });
        for (const result of await Promise.all([
          sendRequest(ws, WS_METHODS.nextTurnQueueSubmit, requests[0]),
          sendRequest(secondClient, WS_METHODS.nextTurnQueueSubmit, requests[1]),
        ]))
          expect(result.error).toBeUndefined();
        const snapshots = [];
        for (const threadId of ["late-one", "late-two"])
          snapshots.push(
            await waitForSetup(ws, threadId, (snapshot) => snapshot?.phase === "done"),
          );
        expect(new Set(snapshots.map((snapshot) => snapshot?.request.branch)).size).toBe(2);
        expect(
          snapshots.every((snapshot) => snapshot?.request.branch.startsWith("f5/shared-title")),
        ).toBe(true);
        await vi.waitFor(() => expect(sentTurns).toHaveLength(2), SLOW_WAIT);
      });
      it("interrupts unfinished naming before the agent starts", async () => {
        const repo = makeGitRepo("f5-ws-naming-timeout-");
        const sentTurns: Array<Parameters<ProviderServiceShape["sendTurn"]>[0]> = [];
        let interrupted = false;
        const generateBranchName = vi.fn(() =>
          Effect.never.pipe(
            Effect.onInterrupt(() =>
              Effect.sync(() => {
                interrupted = true;
              }),
            ),
          ),
        );
        const ws = await startServer({ repo, sentTurns, generateBranchName });
        await createProject(ws, repo);
        const base = firstSend({ repo, threadId: "naming-timeout" });
        await sendRequest(ws, WS_METHODS.nextTurnQueueSubmit, {
          ...base,
          command: {
            ...base.command,
            bootstrap: {
              ...base.command.bootstrap,
              prepareWorktree: {
                ...base.command.bootstrap.prepareWorktree,
                branch: "t3code/99887766",
              },
            },
          },
        });
        const done = await waitForSetup(
          ws,
          "naming-timeout",
          (snapshot) => snapshot?.phase === "done",
        );
        expect(done?.request.branch).toBe("t3code/99887766");
        expect(interrupted).toBe(true);
        expect(generateBranchName).toHaveBeenCalledTimes(1);
        await vi.waitFor(() => expect(sentTurns).toHaveLength(1), SLOW_WAIT);
      });
      it.each(["invalid name", "t3code/ABCDEF12", "main"])(
        "rejects explicit branch %s before creating a conversation",
        async (branch) => {
          const repo = makeGitRepo("f5-ws-explicit-name-");
          const ws = await startServer({ repo, sentTurns: [] });
          await createProject(ws, repo);
          const base = firstSend({ repo, threadId: "invalid-branch" });
          const response = await sendRequest(ws, WS_METHODS.nextTurnQueueSubmit, {
            ...base,
            command: {
              ...base.command,
              bootstrap: {
                ...base.command.bootstrap,
                prepareWorktree: {
                  ...base.command.bootstrap.prepareWorktree,
                  branch,
                  namingIntent: "explicit",
                },
              },
            },
          });
          expect(response.error).toMatchObject({ code: BOOTSTRAP_THREAD_NOT_CREATED_ERROR_CODE });
          expect(response.error?.message).toMatch(/Invalid branch name|already exists/);
          const snapshot = (await sendRequest(ws, ORCHESTRATION_WS_METHODS.getSnapshot))
            .result as OrchestrationReadModel;
          expect(snapshot.threads.some((thread) => thread.id === "invalid-branch")).toBe(false);
        },
      );

      it("reserves an explicit branch before admitting competing conversations", async () => {
        const repo = makeGitRepo("f5-ws-name-reservation-");
        const ws = await startServer({ repo, sentTurns: [] });
        await createProject(ws, repo, {
          command: nodeSetupCommand("setTimeout(() => {}, 30000)"),
          async: false,
        });
        const requests = ["reservation-one", "reservation-two"].map((threadId) => {
          const base = firstSend({ repo, threadId });
          return {
            ...base,
            command: {
              ...base.command,
              bootstrap: {
                ...base.command.bootstrap,
                prepareWorktree: {
                  ...base.command.bootstrap.prepareWorktree,
                  branch: "f5/reserved-name",
                  namingIntent: "explicit",
                },
              },
            },
          };
        });
        const address = h.server!.address();
        const port = typeof address === "object" && address !== null ? address.port : 0;
        const [secondClient] = await connectAndAwaitWelcome(port);
        connections.push(secondClient);
        const results = await Promise.all([
          sendRequest(ws, WS_METHODS.nextTurnQueueSubmit, requests[0]),
          sendRequest(secondClient, WS_METHODS.nextTurnQueueSubmit, requests[1]),
        ]);
        expect(results.filter((result) => result.error === undefined)).toHaveLength(1);
        expect(results.find((result) => result.error)?.error?.code).toBe(
          BOOTSTRAP_THREAD_NOT_CREATED_ERROR_CODE,
        );
        const model = (await sendRequest(ws, ORCHESTRATION_WS_METHODS.getSnapshot))
          .result as OrchestrationReadModel;
        expect(model.threads.filter((thread) => thread.id.startsWith("reservation-"))).toHaveLength(
          1,
        );
      });
      it("honors an explicit setup skip even when the project opts in", async () => {
        const repo = makeGitRepo("f5-ws-skip-setup-");
        const sentTurns: Array<Parameters<ProviderServiceShape["sendTurn"]>[0]> = [];
        const ws = await startServer({ repo, sentTurns });
        await createProject(ws, repo, { command: "echo ran > setup-was-run", async: false });
        const base = firstSend({ repo, threadId: "skip-setup" });
        const response = await sendRequest(ws, WS_METHODS.nextTurnQueueSubmit, {
          ...base,
          command: {
            ...base.command,
            bootstrap: {
              ...base.command.bootstrap,
              prepareWorktree: { ...base.command.bootstrap.prepareWorktree, runSetupScript: false },
            },
          },
        });
        expect(response.error).toBeUndefined();
        const done = await waitForSetup(ws, "skip-setup", (snapshot) => snapshot?.phase === "done");
        expect(done?.stages.find((stage) => stage.id === "setup-script")?.status).toBe("skipped");
        expect(fs.existsSync(path.join(done!.worktreePath!, "setup-was-run"))).toBe(false);
        await vi.waitFor(() => expect(sentTurns).toHaveLength(1), SLOW_WAIT);
      });

      it.each([undefined, true, false])(
        "honors Agent waits for the first send (async: %s)",
        async (async) => {
          const repo = makeGitRepo("f5-ws-async-setup-");
          const sentTurns: Array<Parameters<ProviderServiceShape["sendTurn"]>[0]> = [];
          const ws = await startServer({ repo, sentTurns });
          await createProject(ws, repo, {
            command: nodeSetupCommand("console.log('setup-started'); setTimeout(() => {}, 30000)"),
            ...(async === undefined ? {} : { async }),
          });
          const threadId = "async-setup";
          expect(
            (await sendRequest(ws, WS_METHODS.nextTurnQueueSubmit, firstSend({ repo, threadId })))
              .error,
          ).toBeUndefined();
          await waitForSetup(
            ws,
            threadId,
            (snapshot) =>
              snapshot?.stages
                .find((stage) => stage.id === "setup-script")
                ?.tail.includes("setup-started") === true,
          );
          if (async === false) {
            expect(sentTurns).toHaveLength(0);
            await sendSetupAction(ws, WS_METHODS.worktreeSetupCancel, { threadId });
          } else {
            await vi.waitFor(() => expect(sentTurns).toHaveLength(1), SLOW_WAIT);
            const snapshot = await readSetup(ws, threadId);
            expect(snapshot?.setupScript?.async).toBe(true);
            expect(snapshot?.stages.find((stage) => stage.id === "setup-script")?.status).toBe(
              "running",
            );
          }
        },
      );

      it("reports a failed script and still starts the queued turn once", async () => {
        const repo = makeGitRepo("f5-ws-script-failed-");
        const sentTurns: Array<Parameters<ProviderServiceShape["sendTurn"]>[0]> = [];
        const ws = await startServer({ repo, sentTurns });
        await createProject(ws, repo, { command: "exit 2", async: false });
        await sendRequest(
          ws,
          WS_METHODS.nextTurnQueueSubmit,
          firstSend({ repo, threadId: "script-failed" }),
        );
        const done = await waitForSetup(
          ws,
          "script-failed",
          (snapshot) => snapshot?.phase === "done",
        );
        expect(done?.stages.find((stage) => stage.id === "setup-script")?.status).toBe("failed");
        await vi.waitFor(() => expect(sentTurns).toHaveLength(1), SLOW_WAIT);
      });
      it("pauses the queue when setup fails, then runs the turn in the project checkout", async () => {
        const repo = makeGitRepo("t3code-ws-setup-fail-");
        addOriginRemote(repo);
        const sentTurns: Array<Parameters<ProviderServiceShape["sendTurn"]>[0]> = [];
        const ws = await startServer({ repo, sentTurns });
        await createProject(ws, repo);
        const response = await sendRequest(
          ws,
          WS_METHODS.nextTurnQueueSubmit,
          firstSend({ repo, threadId: "thread-fail", baseBranch: "missing-base" }),
        );
        expect(response.result).toEqual(expect.objectContaining({ disposition: "queued" }));
        const failed = await waitForSetup(ws, "thread-fail", (entry) => entry?.phase === "failed");
        expect(failed?.error).toContain("missing-base");
        const queue = (
          await sendRequest(ws, WS_METHODS.nextTurnQueueList, { threadId: "thread-fail" })
        ).result as { readonly paused: boolean; readonly reasonCode: string | null };
        expect(queue).toEqual(
          expect.objectContaining({ paused: true, reasonCode: "worktree_setup_failed" }),
        );
        expect(sentTurns).toHaveLength(0);

        const local = await sendSetupAction(ws, WS_METHODS.worktreeSetupWorkLocally, {
          threadId: "thread-fail",
        });
        expect(local.error).toBeUndefined();
        await vi.waitFor(() => expect(sentTurns).toHaveLength(1), SLOW_WAIT);
        const snapshot = (await sendRequest(ws, ORCHESTRATION_WS_METHODS.getSnapshot))
          .result as OrchestrationReadModel;
        expect(
          snapshot.threads.find((entry) => entry.id === "thread-fail")?.worktreePath,
        ).toBeNull();
      });

      it("retries a failed setup and starts the turn once the worktree is ready", async () => {
        const repo = makeGitRepo("t3code-ws-setup-retry-");
        addOriginRemote(repo);
        const sentTurns: Array<Parameters<ProviderServiceShape["sendTurn"]>[0]> = [];
        const ws = await startServer({ repo, sentTurns });
        await createProject(ws, repo);
        await sendRequest(
          ws,
          WS_METHODS.nextTurnQueueSubmit,
          firstSend({ repo, threadId: "thread-retry", baseBranch: "later" }),
        );
        const previous = await waitForSetup(
          ws,
          "thread-retry",
          (entry) => entry?.phase === "failed",
        );
        execFileSync("git", ["branch", "later"], { cwd: repo, stdio: "pipe" });

        const retried = await sendSetupAction(ws, WS_METHODS.worktreeSetupRetry, {
          threadId: "thread-retry",
        });
        expect(retried.error).toBeUndefined();
        const done = await waitForSetup(ws, "thread-retry", (entry) => entry?.phase === "done");
        expect(done?.agentStarted).toBe(true);
        expect(done!.generation).toBeGreaterThan(previous!.generation);
        const obsolete = await sendRequest(ws, WS_METHODS.worktreeSetupCancel, {
          threadId: "thread-retry",
          expectedOperationId: previous!.operationId,
        });
        expect(obsolete.error?.message).toContain("obsolete");
        await vi.waitFor(() => expect(sentTurns).toHaveLength(1), SLOW_WAIT);
        expect(sentTurns[0]?.threadId).toBe("thread-retry");
        const snapshot = (await sendRequest(ws, ORCHESTRATION_WS_METHODS.getSnapshot))
          .result as OrchestrationReadModel;
        const thread = snapshot.threads.find((entry) => entry.id === "thread-retry");
        expect(thread?.worktreePath).toBe(done?.worktreePath);
        expect(thread?.branch).toBe("f5/thread-retry");
      });

      it("refuses to discard or work locally once the agent started in the worktree", async () => {
        const repo = makeGitRepo("t3code-ws-setup-started-");
        const sentTurns: Array<Parameters<ProviderServiceShape["sendTurn"]>[0]> = [];
        const ws = await startServer({ repo, sentTurns });
        await createProject(ws, repo);
        await sendRequest(
          ws,
          WS_METHODS.nextTurnQueueSubmit,
          firstSend({ repo, threadId: "thread-started" }),
        );
        const done = await waitForSetup(ws, "thread-started", (entry) => entry?.phase === "done");
        expect(done?.agentStarted).toBe(true);
        await vi.waitFor(() => expect(sentTurns).toHaveLength(1), SLOW_WAIT);

        // The tree is clean, so only the agent-started guard keeps it.
        const discarded = await sendSetupAction(ws, WS_METHODS.worktreeSetupCancel, {
          threadId: "thread-started",
        });
        expect(discarded.error?.message).toContain("agent already started");
        const local = await sendSetupAction(ws, WS_METHODS.worktreeSetupWorkLocally, {
          threadId: "thread-started",
        });
        expect(local.error?.message).toContain("agent already started");
        expect(fs.existsSync(done!.worktreePath!)).toBe(true);
        expect(branchExists(repo, "f5/thread-started")).toBe(true);
      });

      it("fans one prompt out to three models in three separate worktrees", async () => {
        const repo = makeGitRepo("t3code-ws-setup-fanout-");
        const sentTurns: Array<Parameters<ProviderServiceShape["sendTurn"]>[0]> = [];
        const ws = await startServer({ repo, sentTurns });
        await createProject(ws, repo);
        const threadIds = ["thread-fan-a", "thread-fan-b", "thread-fan-c"];
        const responses = await Promise.all(
          threadIds.map(async (threadId) => {
            const [socket] = await connectAndAwaitWelcome(
              (h.server!.address() as { port: number }).port,
            );
            connections.push(socket);
            return sendRequest(
              socket,
              WS_METHODS.nextTurnQueueSubmit,
              firstSend({ repo, threadId, requireWorktree: true }),
            );
          }),
        );
        for (const response of responses) {
          expect(response.result).toEqual(expect.objectContaining({ disposition: "queued" }));
        }
        await vi.waitFor(() => expect(sentTurns).toHaveLength(3), SLOW_WAIT);
        const snapshot = (await sendRequest(ws, ORCHESTRATION_WS_METHODS.getSnapshot))
          .result as OrchestrationReadModel;
        const worktrees = threadIds.map(
          (threadId) => snapshot.threads.find((entry) => entry.id === threadId)?.worktreePath,
        );
        expect(new Set(worktrees).size).toBe(3);
        for (const worktree of worktrees) expect(worktree && fs.existsSync(worktree)).toBe(true);
      });

      it("rejects manual removal from an unknown project cwd", async () => {
        const repo = makeGitRepo("t3code-ws-removal-project-");
        const ws = await startServer({ repo, sentTurns: [] });
        await createProject(ws, repo);
        const result = await sendRequest(ws, WS_METHODS.gitRemoveWorktree, {
          cwd: path.join(repo, "unknown"),
          path: path.join(repo, "untouched"),
        });
        expect(result.error?.message).toBe("Unknown project");
      });

      it("cancel mid-setup removes the clean worktree and the branch it created", async () => {
        const repo = makeGitRepo("t3code-ws-setup-cancel-clean-");
        const sentTurns: Array<Parameters<ProviderServiceShape["sendTurn"]>[0]> = [];
        const ws = await startServer({ repo, sentTurns });
        await createProject(ws, repo, {
          command: nodeSetupCommand("setTimeout(() => {}, 30000)"),
          async: false,
        });
        await sendRequest(
          ws,
          WS_METHODS.nextTurnQueueSubmit,
          firstSend({ repo, threadId: "thread-cancel-clean" }),
        );
        const running = await waitForSetup(
          ws,
          "thread-cancel-clean",
          (entry) =>
            entry?.stages.find((stage) => stage.id === "setup-script")?.status === "running",
        );
        const worktreePath = running?.worktreePath;
        expect(worktreePath && fs.existsSync(worktreePath)).toBe(true);

        const cancelled = await sendSetupAction(ws, WS_METHODS.worktreeSetupCancel, {
          threadId: "thread-cancel-clean",
        });
        expect(cancelled.error).toBeUndefined();
        expect((cancelled.result as { snapshot: WorktreeSetupSnapshot }).snapshot.phase).toBe(
          "cancelled",
        );
        expect(fs.existsSync(worktreePath!)).toBe(false);
        expect(branchExists(repo, "f5/thread-cancel-clean")).toBe(false);
        const queue = (
          await sendRequest(ws, WS_METHODS.nextTurnQueueList, { threadId: "thread-cancel-clean" })
        ).result as { readonly paused: boolean; readonly reasonCode: string | null };
        expect(queue).toEqual(
          expect.objectContaining({ paused: true, reasonCode: "worktree_setup_cancelled" }),
        );
        expect(sentTurns).toHaveLength(0);
      });

      it("rejects an existing explicit branch and preserves its commits", async () => {
        const repo = makeGitRepo("t3code-ws-setup-existing-cancel-");
        const branch = "f5/thread-existing-cancel";
        const git = (...args: string[]) =>
          execFileSync("git", args, { cwd: repo, stdio: "pipe" }).toString().trim();
        git("branch", branch);
        const existingHead = git("rev-parse", branch);
        const ws = await startServer({ repo, sentTurns: [] });
        await createProject(ws, repo);
        const submitted = await sendRequest(
          ws,
          WS_METHODS.nextTurnQueueSubmit,
          firstSend({ repo, threadId: "thread-existing-cancel" }),
        );
        expect(submitted.error).toMatchObject({ code: BOOTSTRAP_THREAD_NOT_CREATED_ERROR_CODE });
        expect(submitted.error?.message).toContain("already exists");
        expect(git("rev-parse", branch)).toBe(existingHead);
        expect(await readSetup(ws, "thread-existing-cancel")).toBeNull();
      });

      it("cancel after the setup script wrote files keeps the worktree and branch", async () => {
        const repo = makeGitRepo("t3code-ws-setup-cancel-kept-");
        const sentTurns: Array<Parameters<ProviderServiceShape["sendTurn"]>[0]> = [];
        const ws = await startServer({ repo, sentTurns });
        await createProject(ws, repo, {
          command: nodeSetupCommand(
            "require('node:fs').writeFileSync('generated.txt', 'generated'); setTimeout(() => {}, 30000)",
          ),
          async: false,
        });
        await sendRequest(
          ws,
          WS_METHODS.nextTurnQueueSubmit,
          firstSend({ repo, threadId: "thread-cancel-kept" }),
        );
        const running = await waitForSetup(
          ws,
          "thread-cancel-kept",
          (entry) =>
            entry?.worktreePath != null &&
            fs.existsSync(path.join(entry.worktreePath, "generated.txt")),
        );
        const cancelled = await sendSetupAction(ws, WS_METHODS.worktreeSetupCancel, {
          threadId: "thread-cancel-kept",
        });
        const settled = (cancelled.result as { snapshot: WorktreeSetupSnapshot }).snapshot;
        expect(settled.phase).toBe("cancelled_kept");
        expect(settled.error).toContain("uncommitted");
        expect(fs.existsSync(path.join(running!.worktreePath!, "generated.txt"))).toBe(true);
        expect(branchExists(repo, "f5/thread-cancel-kept")).toBe(true);
        const queue = (
          await sendRequest(ws, WS_METHODS.nextTurnQueueList, { threadId: "thread-cancel-kept" })
        ).result as { readonly reasonCode: string | null };
        expect(queue.reasonCode).toBe("worktree_setup_cancelled_kept");
        expect(sentTurns).toHaveLength(0);
      });

      it("cancel keeps a worktree whose only new file is gitignored", async () => {
        const repo = makeGitRepo("t3code-ws-setup-cancel-ignored-");
        fs.writeFileSync(path.join(repo, ".gitignore"), ".env\n");
        execFileSync("git", ["add", ".gitignore"], { cwd: repo, stdio: "pipe" });
        execFileSync(
          "git",
          ["-c", "user.name=F5", "-c", "user.email=f5@example.com", "commit", "-qm", "ignore"],
          { cwd: repo, stdio: "pipe" },
        );
        const sentTurns: Array<Parameters<ProviderServiceShape["sendTurn"]>[0]> = [];
        const ws = await startServer({ repo, sentTurns });
        await createProject(ws, repo, {
          command: `"${process.execPath}" -e "require('node:fs').writeFileSync('.env', 'SECRET=1\\n'); setTimeout(() => {}, 30000)"`,
          async: false,
        });
        await sendRequest(
          ws,
          WS_METHODS.nextTurnQueueSubmit,
          firstSend({ repo, threadId: "thread-cancel-ignored" }),
        );
        const running = await waitForSetup(
          ws,
          "thread-cancel-ignored",
          (entry) =>
            entry?.worktreePath != null && fs.existsSync(path.join(entry.worktreePath, ".env")),
        );
        // `git status` reports the tree clean; only the ignored-file check keeps it.
        const cancelled = await sendSetupAction(ws, WS_METHODS.worktreeSetupCancel, {
          threadId: "thread-cancel-ignored",
        });
        const settled = (cancelled.result as { snapshot: WorktreeSetupSnapshot }).snapshot;
        expect(settled.phase).toBe("cancelled_kept");
        expect(settled.error).toContain(".env");
        expect(fs.readFileSync(path.join(running!.worktreePath!, ".env"), "utf8")).toBe(
          "SECRET=1\n",
        );
      });

      it("marks a setup that was running at shutdown as failed and removes nothing", async () => {
        const repo = makeGitRepo("t3code-ws-setup-restart-");
        const stateDir = makeTempDir("t3code-ws-setup-restart-state-");
        const dbPath = path.join(stateDir, "state.sqlite");
        const persistence = () =>
          makeSqlitePersistenceLive(dbPath).pipe(Layer.provide(NodeServices.layer));
        const sentTurns: Array<Parameters<ProviderServiceShape["sendTurn"]>[0]> = [];
        let ws = await startServer({ repo, stateDir, persistenceLayer: persistence(), sentTurns });
        await createProject(ws, repo, {
          command: nodeSetupCommand("setTimeout(() => {}, 30000)"),
          async: false,
        });
        await sendRequest(
          ws,
          WS_METHODS.nextTurnQueueSubmit,
          firstSend({ repo, threadId: "thread-restart" }),
        );
        const running = await waitForSetup(
          ws,
          "thread-restart",
          (entry) =>
            entry?.stages.find((stage) => stage.id === "setup-script")?.status === "running",
        );
        // Let the throttled activity write land before the restart.
        await new Promise((resolve) => setTimeout(resolve, 700));
        for (const socket of connections.splice(0)) socket.close();
        await closeTestServer();
        h.server = null;

        ws = await startServer({ repo, stateDir, persistenceLayer: persistence(), sentTurns });
        const failed = await waitForSetup(
          ws,
          "thread-restart",
          (entry) => entry?.phase === "failed",
        );
        expect(failed?.error).toContain("restart");
        expect(failed!.generation).toBeGreaterThan(running!.generation);
        expect(failed!.sequence).toBeGreaterThan(running!.sequence);
        expect(fs.existsSync(running!.worktreePath!)).toBe(true);
        const queue = (
          await sendRequest(ws, WS_METHODS.nextTurnQueueList, { threadId: "thread-restart" })
        ).result as { readonly paused: boolean; readonly reasonCode: string | null };
        expect(queue).toEqual(
          expect.objectContaining({ paused: true, reasonCode: "worktree_setup_failed" }),
        );
        expect(sentTurns).toHaveLength(0);
      });
    });

    it("reports a first send whose thread was not created so the client can retry", async () => {
      const stateDir = makeTempDir("t3code-ws-first-send-rollback-");
      const repo = makeGitRepo("t3code-ws-first-send-rollback-repo-");
      h.server = await createTestServer({ cwd: repo, stateDir });
      const addr = h.server.address();
      const port = typeof addr === "object" && addr !== null ? addr.port : 0;
      const [ws] = await connectAndAwaitWelcome(port);
      connections.push(ws);
      const createdAt = new Date().toISOString();
      await sendRequest(ws, ORCHESTRATION_WS_METHODS.dispatchCommand, {
        type: "project.create",
        commandId: "command-rollback-project",
        projectId: "project-rollback",
        title: "Rollback",
        workspaceRoot: repo,
        defaultModel: "gpt-5-codex",
        createdAt,
      });
      const response = await sendRequest(ws, WS_METHODS.nextTurnQueueSubmit, {
        submissionId: "submission-rollback",
        intent: "auto",
        command: {
          type: "thread.turn.start",
          commandId: "submission-rollback",
          threadId: "thread-rollback",
          message: { messageId: "message-rollback", role: "user", text: "Go.", attachments: [] },
          provider: "codex",
          assistantDeliveryMode: "streaming",
          runtimeMode: "full-access",
          interactionMode: "default",
          bootstrap: {
            createThread: {
              // An unknown project makes thread creation fail before it commits.
              projectId: "project-missing",
              title: "New thread",
              model: "gpt-5-codex",
              runtimeMode: "full-access",
              interactionMode: "default",
              branch: null,
              worktreePath: null,
              createdAt,
            },
          },
          createdAt,
        },
      });
      expect(response.error).toEqual(
        expect.objectContaining({ code: BOOTSTRAP_THREAD_NOT_CREATED_ERROR_CODE }),
      );
      const snapshot = (await sendRequest(ws, ORCHESTRATION_WS_METHODS.getSnapshot))
        .result as OrchestrationReadModel;
      expect(snapshot.threads.some((entry) => entry.id === "thread-rollback")).toBe(false);
    });
  });

  it("rejects an invalid bootstrap attachment before creating the thread", async () => {
    const stateDir = makeTempDir("t3code-ws-bootstrap-invalid-attachment-");
    const workspaceRoot = makeTempDir("t3code-ws-bootstrap-invalid-attachment-workspace-");
    const dbPath = path.join(stateDir, "state.sqlite");
    const persistenceLayer = makeSqlitePersistenceLive(dbPath).pipe(
      Layer.provide(NodeServices.layer),
    );
    h.server = await createTestServer({ cwd: workspaceRoot, persistenceLayer, stateDir });
    const addr = h.server.address();
    const port = typeof addr === "object" && addr !== null ? addr.port : 0;
    const [ws] = await connectAndAwaitWelcome(port);
    connections.push(ws);
    const createdAt = new Date().toISOString();
    const projectId = "project-bootstrap-invalid-attachment";
    const threadId = "thread-bootstrap-invalid-attachment";

    expect(
      (
        await sendRequest(ws, ORCHESTRATION_WS_METHODS.dispatchCommand, {
          type: "project.create",
          commandId: "command-bootstrap-invalid-attachment-project",
          projectId,
          title: "Bootstrap Invalid Attachment",
          workspaceRoot,
          defaultModel: "gpt-5-codex",
          createdAt,
        })
      ).error,
    ).toBeUndefined();

    const response = await sendRequest(ws, ORCHESTRATION_WS_METHODS.dispatchCommand, {
      type: "thread.turn.start",
      commandId: "command-bootstrap-invalid-attachment-turn",
      threadId,
      message: {
        messageId: "message-bootstrap-invalid-attachment",
        role: "user",
        text: "Invalid image",
        attachments: [
          {
            type: "image",
            name: "invalid.png",
            mimeType: "image/png",
            sizeBytes: 5,
            dataUrl: "data:text/plain;base64,aGVsbG8=",
          },
        ],
      },
      assistantDeliveryMode: "streaming",
      runtimeMode: "full-access",
      interactionMode: "default",
      bootstrap: {
        createThread: {
          projectId,
          title: "New thread",
          model: "gpt-5-codex",
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdAt,
        },
      },
      createdAt,
    });
    expect(response.error?.message).toContain("Invalid image attachment payload");

    const snapshotResponse = await sendRequest(ws, ORCHESTRATION_WS_METHODS.getSnapshot);
    const snapshot = snapshotResponse.result as OrchestrationReadModel;
    expect(snapshot.threads.some((entry) => entry.id === threadId)).toBe(false);
    const database = new DatabaseSync(dbPath, { readOnly: true });
    try {
      expect(database.prepare("SELECT COUNT(*) AS count FROM attachments").get()).toEqual({
        count: 0,
      });
    } finally {
      database.close();
    }
    const attachmentsDir = path.join(stateDir, "attachments");
    expect(
      fs.existsSync(attachmentsDir) ? fs.readdirSync(attachmentsDir, { recursive: true }) : [],
    ).toEqual([]);
  });

  it("cleans bootstrap attachments after a definitely rejected final dispatch", async () => {
    const stateDir = makeTempDir("t3code-ws-bootstrap-rejected-attachment-");
    const workspaceRoot = makeTempDir("t3code-ws-bootstrap-rejected-attachment-workspace-");
    const dbPath = path.join(stateDir, "state.sqlite");
    const persistenceLayer = makeSqlitePersistenceLive(dbPath).pipe(
      Layer.provide(NodeServices.layer),
    );
    h.server = await createTestServer({ cwd: workspaceRoot, persistenceLayer, stateDir });
    const addr = h.server.address();
    const port = typeof addr === "object" && addr !== null ? addr.port : 0;
    const [ws] = await connectAndAwaitWelcome(port);
    connections.push(ws);
    const createdAt = new Date().toISOString();
    const projectId = "project-bootstrap-rejected-attachment";
    const threadId = "thread-bootstrap-rejected-attachment";

    expect(
      (
        await sendRequest(ws, ORCHESTRATION_WS_METHODS.dispatchCommand, {
          type: "project.create",
          commandId: "command-bootstrap-rejected-attachment-project",
          projectId,
          title: "Bootstrap Rejected Attachment",
          workspaceRoot,
          defaultModel: "gpt-5-codex",
          createdAt,
        })
      ).error,
    ).toBeUndefined();

    const response = await sendRequest(ws, ORCHESTRATION_WS_METHODS.dispatchCommand, {
      type: "thread.turn.start",
      commandId: "command-bootstrap-rejected-attachment-turn",
      threadId,
      message: {
        messageId: "message-bootstrap-rejected-attachment",
        role: "user",
        text: "Reject after attachment persistence",
        attachments: [
          {
            type: "image",
            name: "rejected.png",
            mimeType: "image/png",
            sizeBytes: 5,
            dataUrl: "data:image/png;base64,aGVsbG8=",
          },
        ],
      },
      sourceProposedPlan: { threadId, planId: "missing-plan" },
      assistantDeliveryMode: "streaming",
      runtimeMode: "full-access",
      interactionMode: "default",
      bootstrap: {
        createThread: {
          projectId,
          title: "New thread",
          model: "gpt-5-codex",
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdAt,
        },
      },
      createdAt,
    });
    expect(response.error?.message).toContain("does not exist");

    const snapshotResponse = await sendRequest(ws, ORCHESTRATION_WS_METHODS.getSnapshot);
    const snapshot = snapshotResponse.result as OrchestrationReadModel;
    expect(
      snapshot.threads.some((entry) => entry.id === threadId && entry.deletedAt === null),
    ).toBe(false);
    const database = new DatabaseSync(dbPath, { readOnly: true });
    try {
      expect(database.prepare("SELECT COUNT(*) AS count FROM attachments").get()).toEqual({
        count: 0,
      });
    } finally {
      database.close();
    }
    const attachmentFiles = fs
      .readdirSync(path.join(stateDir, "attachments"), { recursive: true })
      .map(String)
      .filter((entry) => entry.endsWith(".png"));
    expect(attachmentFiles).toEqual([]);
  });

  it("deduplicates concurrent attachment submissions without leaving losing ingress files", async () => {
    const stateDir = makeTempDir("t3code-ws-queue-attachment-replay-");
    const workspaceRoot = makeTempDir("t3code-ws-queue-attachment-workspace-");
    h.server = await createTestServer({ cwd: workspaceRoot, stateDir });
    const addr = h.server.address();
    const port = typeof addr === "object" && addr !== null ? addr.port : 0;
    const [ws] = await connectAndAwaitWelcome(port);
    connections.push(ws);
    const [secondWs] = await connectAndAwaitWelcome(port);
    connections.push(secondWs);
    const createdAt = new Date().toISOString();

    expect(
      (
        await sendRequest(ws, ORCHESTRATION_WS_METHODS.dispatchCommand, {
          type: "project.create",
          commandId: "cmd-attachment-replay-project",
          projectId: "project-attachment-replay",
          title: "Attachment Replay",
          workspaceRoot,
          defaultModel: "gpt-5-codex",
          createdAt,
        })
      ).error,
    ).toBeUndefined();
    expect(
      (
        await sendRequest(ws, ORCHESTRATION_WS_METHODS.dispatchCommand, {
          type: "thread.create",
          commandId: "cmd-attachment-replay-thread",
          threadId: "thread-attachment-replay",
          projectId: "project-attachment-replay",
          title: "Attachment Replay",
          model: "gpt-5-codex",
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdAt,
        })
      ).error,
    ).toBeUndefined();

    const input = {
      submissionId: "submission-attachment-replay",
      intent: "queue-tail",
      command: {
        type: "thread.turn.start",
        commandId: "cmd-attachment-replay-turn",
        threadId: "thread-attachment-replay",
        message: {
          messageId: "message-attachment-replay-turn",
          role: "user",
          text: "image",
          attachments: [
            {
              type: "image",
              name: "image.png",
              mimeType: "image/png",
              sizeBytes: 5,
              dataUrl: "data:image/png;base64,aGVsbG8=",
            },
          ],
        },
        assistantDeliveryMode: "streaming",
        runtimeMode: "full-access",
        interactionMode: "default",
        createdAt,
      },
    };
    const [first, second] = await Promise.all([
      sendRequest(ws, WS_METHODS.nextTurnQueueSubmit, input),
      sendRequest(secondWs, WS_METHODS.nextTurnQueueSubmit, input),
    ]);
    expect(first.error).toBeUndefined();
    expect(second.error).toBeUndefined();
    expect(first.result).toEqual(expect.objectContaining({ disposition: "queued" }));
    expect(second.result).toEqual(expect.objectContaining({ disposition: "queued" }));

    const snapshotResponse = await sendRequest(ws, WS_METHODS.nextTurnQueueList, {
      threadId: "thread-attachment-replay",
    });
    const snapshot = snapshotResponse.result as {
      items: Array<{ command: { message: { attachments: Array<{ id: string }> } } }>;
    };
    expect(snapshot.items).toHaveLength(1);
    const attachmentId = snapshot.items[0]?.command.message.attachments[0]?.id;
    expect(attachmentId).toBeTruthy();
    const attachmentFiles = fs
      .readdirSync(path.join(stateDir, "attachments"), { recursive: true })
      .map(String)
      .filter((entry) => entry.endsWith(".png"));
    expect(attachmentFiles).toHaveLength(1);
    expect(attachmentFiles[0]).toContain(attachmentId);
  });

  it("keeps orchestration domain push behavior for provider runtime events", async () => {
    let targetedRefreshCalls = 0;
    const usageInstanceId = defaultInstanceIdForDriver(ProviderDriverKind.make("codex"));
    const usageRegistryLayer = Layer.effect(
      ProviderInstanceRegistry,
      Effect.gen(function* () {
        const capability = yield* makeAccountUsageCapability(
          {
            key: usageInstanceId,
            provider: "codex",
            providerInstanceId: usageInstanceId,
            displayName: "Codex",
            enabled: true,
            refreshState: "idle",
            sections: [emptyAccountSection("codex-limits")],
          },
          Effect.succeed([]),
          { identity: "test:codex" },
        );
        const instance = {
          instanceId: usageInstanceId,
          enabled: true,
          driverKind: ProviderDriverKind.make("codex"),
          continuationIdentity: {
            driverKind: ProviderDriverKind.make("codex"),
            continuationKey: usageInstanceId,
          },
          displayName: undefined,
          snapshot: {
            getSnapshot: Effect.succeed(defaultProviderSnapshots[0]!),
            refresh: Effect.succeed(defaultProviderSnapshots[0]!),
            streamChanges: Stream.empty,
          },
          adapter: {} as ProviderInstance["adapter"],
          textGeneration: {} as ProviderInstance["textGeneration"],
          accountUsage: {
            ...capability,
            refreshAccount: (permits) => {
              targetedRefreshCalls++;
              return capability.refreshAccount!(permits);
            },
          },
        } as ProviderInstance;
        return {
          getInstance: (id) => Effect.succeed(id === usageInstanceId ? instance : undefined),
          listInstances: Effect.succeed([instance]),
          listUnavailable: Effect.succeed([]),
          streamChanges: Stream.empty,
          subscribeChanges: Effect.acquireRelease(PubSub.unbounded<void>(), PubSub.shutdown).pipe(
            Effect.flatMap(PubSub.subscribe),
          ),
        };
      }),
    );
    const runtimeEventPubSub = Effect.runSync(PubSub.unbounded<ProviderRuntimeEvent>());
    const emitRuntimeEvent = (event: ProviderRuntimeEvent) => {
      Effect.runSync(PubSub.publish(runtimeEventPubSub, event));
    };
    const unsupported = () => Effect.die(new Error("Unsupported provider call in test")) as never;
    const providerService: ProviderServiceShape = {
      replaceSession: () => unsupported(),
      startSession: (threadId) =>
        Effect.succeed({
          provider: "codex",
          status: "ready",
          runtimeMode: "full-access",
          threadId,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        }),
      sendTurn: ({ threadId }) =>
        Effect.succeed({
          threadId,
          turnId: asTurnId("provider-turn-1"),
        }),
      interruptTurn: () => unsupported(),
      respondToRequest: () => unsupported(),
      respondToUserInput: () => unsupported(),
      respondToElicitation: () => unsupported(),
      stopSession: () => unsupported(),
      listStartingWorkspaces: () => Effect.succeed([]),
      listSessions: () => Effect.succeed([]),
      getSessionCapabilities: () => Effect.succeed(null),
      assertSessionAction: () => Effect.die(new Error("assertSessionAction is unused here")),
      getCapabilities: () => Effect.succeed({ sessionModelSwitch: "in-session" }),
      readThread: () => unsupported(),
      rollbackConversation: () => unsupported(),
      runOneOffPrompt: () => unsupported(),
      compactConversation: () => unsupported(),
      reloadMcpConfigForProject: () => unsupported(),
      streamEvents: Stream.fromPubSub(runtimeEventPubSub),
    };
    const providerLayer = Layer.succeed(ProviderService, providerService);

    const usageStateDir = makeTempDir("t3code-ws-usage-recovery-");
    const usageDbPath = path.join(usageStateDir, "state.sqlite");
    h.server = await createTestServer({
      cwd: "/test",
      providerLayer,
      providerInstanceRegistryLayer: usageRegistryLayer,
      stateDir: usageStateDir,
      persistenceLayer: makeSqlitePersistenceLive(usageDbPath).pipe(
        Layer.provide(NodeServices.layer),
      ),
    });
    const addr = h.server.address();
    const port = typeof addr === "object" && addr !== null ? addr.port : 0;

    const [ws] = await connectAndAwaitWelcome(port);
    connections.push(ws);

    const workspaceRoot = makeTempDir("t3code-ws-project-");
    const createdAt = new Date().toISOString();
    const createProjectResponse = await sendRequest(ws, ORCHESTRATION_WS_METHODS.dispatchCommand, {
      type: "project.create",
      commandId: "cmd-ws-project-create",
      projectId: "project-1",
      title: "WS Project",
      workspaceRoot,
      defaultModel: "gpt-5-codex",
      createdAt,
    });
    expect(createProjectResponse.error).toBeUndefined();
    const createThreadResponse = await sendRequest(ws, ORCHESTRATION_WS_METHODS.dispatchCommand, {
      type: "thread.create",
      commandId: "cmd-ws-runtime-thread-create",
      threadId: "thread-1",
      projectId: "project-1",
      title: "Thread 1",
      model: "gpt-5-codex",
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdAt,
    });
    expect(createThreadResponse.error).toBeUndefined();

    const startTurnResponse = await sendRequest(ws, WS_METHODS.nextTurnQueueSubmit, {
      submissionId: "submission-ws-runtime-turn-start",
      intent: "auto",
      command: {
        type: "thread.turn.start",
        commandId: "cmd-ws-runtime-turn-start",
        threadId: "thread-1",
        message: {
          messageId: "msg-ws-runtime-1",
          role: "user",
          text: "hello",
          attachments: [],
        },
        assistantDeliveryMode: "streaming",
        runtimeMode: "approval-required",
        interactionMode: "default",
        createdAt,
      },
    });
    expect(startTurnResponse.error).toBeUndefined();

    await waitForPush(ws, ORCHESTRATION_WS_CHANNELS.domainEvent, (push) => {
      const event = push.data as { type?: string };
      return event.type === "thread.session-set";
    });

    emitRuntimeEvent({
      type: "content.delta",
      eventId: asEventId("evt-ws-runtime-message-delta"),
      provider: "codex",
      threadId: asThreadId("thread-1"),
      createdAt: new Date().toISOString(),
      turnId: asTurnId("turn-1"),
      itemId: asProviderItemId("item-1"),
      payload: {
        streamKind: "assistant_text",
        delta: "hello from runtime",
      },
    } as unknown as ProviderRuntimeEvent);

    const domainPush = await waitForPush(ws, ORCHESTRATION_WS_CHANNELS.domainEvent, (push) => {
      const event = push.data as { type?: string; payload?: { messageId?: string; text?: string } };
      return (
        event.type === "thread.message-sent" && event.payload?.messageId === "assistant:item-1"
      );
    });

    const domainEvent = domainPush.data as {
      type: string;
      payload: { messageId: string; text: string };
    };
    expect(domainEvent.type).toBe("thread.message-sent");
    expect(domainEvent.payload.messageId).toBe("assistant:item-1");
    expect(domainEvent.payload.text).toBe("hello from runtime");

    // Exercise both optional consumers through the production runtime layer,
    // rather than supplying UsageService directly to isolated test layers.
    emitRuntimeEvent({
      type: "runtime.error",
      eventId: asEventId("evt-usage-composition"),
      provider: "codex",
      providerInstanceId: usageInstanceId,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("provider-turn-1"),
      createdAt: new Date().toISOString(),
      payload: {
        message: "Usage limit reached",
        usageLimit: { windows: [], resetsAt: null, resetSource: null, evidence: "typed" },
      },
    });
    await vi.waitFor(() => expect(targetedRefreshCalls).toBeGreaterThan(0));
    const refreshCallsBeforeRoute = targetedRefreshCalls;
    const refreshed = await sendRequest(ws, WS_METHODS.nextTurnQueueRefreshUsageLimitResume, {
      threadId: "thread-1",
      expectedLimitKey: `instance:${usageInstanceId}:turn:provider-turn-1`,
    });
    expect(refreshed.error).toBeUndefined();
    expect(targetedRefreshCalls).toBeGreaterThan(refreshCallsBeforeRoute);

    emitRuntimeEvent({
      type: "turn.completed",
      eventId: asEventId("evt-usage-terminal"),
      provider: "codex",
      providerInstanceId: usageInstanceId,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("provider-turn-1"),
      createdAt: new Date().toISOString(),
      payload: {
        state: "failed",
        errorMessage: "Usage limit reached",
        usageLimit: {
          windows: [],
          resetsAt: null,
          resetSource: null,
          evidence: "typed",
        },
      },
    });
    await vi.waitFor(async () => {
      const model = await sendRequest(ws, ORCHESTRATION_WS_METHODS.getSnapshot);
      const thread = (model.result as OrchestrationReadModel).threads.find(
        (entry) => entry.id === "thread-1",
      );
      expect(thread?.session?.activeTurnId).toBeNull();
      expect(thread?.session?.usageLimit?.turnId).toBe("provider-turn-1");
    });
    const stale = await sendRequest(ws, WS_METHODS.nextTurnQueueScheduleUsageLimitResume, {
      threadId: "thread-1",
      expectedLimitKey: "instance:other:turn:old",
      notBefore: new Date(Date.now() + 3_600_000).toISOString(),
    });
    expect(stale.error?.message).toMatch(/changed|stale/i);
    const scheduled = await sendRequest(ws, WS_METHODS.nextTurnQueueScheduleUsageLimitResume, {
      threadId: "thread-1",
      expectedLimitKey: `instance:${usageInstanceId}:turn:provider-turn-1`,
      notBefore: new Date(Date.now() + 3_600_000).toISOString(),
    });
    expect(scheduled.error).toBeUndefined();
    const scheduledSnapshot = scheduled.result as {
      revision: number;
      items: Array<{ itemId: string; scheduleReason?: string }>;
    };
    const recoveryItem = scheduledSnapshot.items.find(
      (item) => item.scheduleReason === "usage_limit_reset",
    )!;
    // Hold the durable row in the acceptance state to exercise the route's
    // typed race result without sending a real provider turn.
    const usageDb = new DatabaseSync(usageDbPath);
    try {
      usageDb
        .prepare("UPDATE next_turn_queue SET status = 'dispatching' WHERE item_id = ?")
        .run(recoveryItem.itemId);
      const cancelSending = await sendRequest(ws, WS_METHODS.nextTurnQueueCancelUsageLimitResume, {
        threadId: "thread-1",
        itemId: recoveryItem.itemId,
        expectedRevision: scheduledSnapshot.revision,
      });
      expect(cancelSending.error).toBeUndefined();
      expect(cancelSending.result).toEqual(expect.objectContaining({ kind: "already_sending" }));
    } finally {
      usageDb
        .prepare("UPDATE next_turn_queue SET status = 'queued' WHERE item_id = ?")
        .run(recoveryItem.itemId);
      usageDb.close();
    }
    const command = (id: string) => ({
      type: "thread.turn.start",
      commandId: `cmd-${id}`,
      threadId: "thread-1",
      message: { messageId: `msg-${id}`, role: "user", text: "follow up", attachments: [] },
      assistantDeliveryMode: "streaming",
      runtimeMode: "approval-required",
      interactionMode: "default",
      createdAt: new Date().toISOString(),
    });
    const tail = await sendRequest(ws, WS_METHODS.nextTurnQueueSubmit, {
      submissionId: "usage-tail",
      intent: "queue-tail",
      command: command("usage-tail"),
    });
    expect(tail.error).toBeUndefined();
    const queueAfterTail = await sendRequest(ws, WS_METHODS.nextTurnQueueList, {
      threadId: "thread-1",
    });
    expect(
      (queueAfterTail.result as { items: Array<{ scheduleReason?: string }> }).items.some(
        (item) => item.scheduleReason === "usage_limit_reset",
      ),
    ).toBe(true);
    const immediate = await sendRequest(ws, WS_METHODS.nextTurnQueueSubmit, {
      submissionId: "usage-immediate",
      intent: "auto",
      command: command("usage-immediate"),
    });
    expect(immediate.error).toBeUndefined();
    const queueAfterImmediate = await sendRequest(ws, WS_METHODS.nextTurnQueueList, {
      threadId: "thread-1",
    });
    expect(
      (queueAfterImmediate.result as { items: Array<{ scheduleReason?: string }> }).items.some(
        (item) => item.scheduleReason === "usage_limit_reset",
      ),
    ).toBe(false);
  });

  it("native fork persists and prepares the flat branch when t3code already exists", async () => {
    const workspaceRoot = makeTempDir("f5-native-fork-repo-");
    const stateDir = makeTempDir("f5-native-fork-state-");
    const git = (...args: string[]) =>
      execFileSync("git", ["-C", workspaceRoot, ...args], { encoding: "utf8" }).trim();
    git("init", "-q", "-b", "main");
    git(
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.com",
      "commit",
      "-q",
      "--allow-empty",
      "-m",
      "initial",
    );
    git("branch", "t3code");
    const nativeOperations: NonNullable<ProviderServiceShape["nativeOperations"]> = {
      list: () => unsupportedProviderCall(),
      inspect: () => unsupportedProviderCall(),
      resolve: () => unsupportedProviderCall(),
      execute: () => unsupportedProviderCall(),
      executeWithApply: (input, apply, prepare) =>
        Effect.gen(function* () {
          if (prepare) yield* prepare;
          yield* apply({ resumeCursor: { nativeThreadId: "forked-native-session" } });
          const now = new Date().toISOString();
          return { ...input, state: "completed" as const, createdAt: now, updatedAt: now };
        }),
    };
    h.server = await createTestServer({
      cwd: workspaceRoot,
      stateDir,
      persistenceLayer: makeSqlitePersistenceLive(path.join(stateDir, "state.sqlite")).pipe(
        Layer.provide(NodeServices.layer),
      ),
      providerLayer: Layer.succeed(ProviderService, {
        ...defaultProviderService,
        nativeOperations,
      }),
    });
    const address = h.server.address();
    const [ws] = await connectAndAwaitWelcome(
      typeof address === "object" && address !== null ? address.port : 0,
    );
    connections.push(ws);
    const now = new Date().toISOString();
    const project = await sendRequest(ws, ORCHESTRATION_WS_METHODS.dispatchCommand, {
      type: "project.create",
      commandId: "fork-project-create",
      projectId: "fork-project",
      title: "Fork",
      workspaceRoot,
      createdAt: now,
    });
    expect(project.error).toBeUndefined();
    const source = await sendRequest(ws, ORCHESTRATION_WS_METHODS.dispatchCommand, {
      type: "thread.create",
      commandId: "fork-source-create",
      threadId: "fork-source",
      projectId: "fork-project",
      title: "Source",
      model: "gpt-5-codex",
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: "main",
      worktreePath: null,
      createdAt: now,
    });
    expect(source.error).toBeUndefined();
    const database = new DatabaseSync(path.join(stateDir, "state.sqlite"));
    try {
      database
        .prepare(
          "INSERT INTO provider_session_runtime (thread_id, project_id, provider_name, provider_instance_id, adapter_key, runtime_mode, status, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .run(
          "fork-source",
          "fork-project",
          "codex",
          "codex",
          "codex",
          "full-access",
          "stopped",
          now,
        );
      const operationId = "abcdef12-1234-4234-8234-123456789abc";
      const response = await sendRequest(ws, NATIVE_OPERATION_WS_METHODS.fork, {
        threadId: "fork-source",
        operationId,
        generation: 1,
      });
      expect(response.error).toBeUndefined();
      expect(response.result).toMatchObject({ state: "completed" });
      const snapshot = await sendRequest(ws, ORCHESTRATION_WS_METHODS.getSnapshot);
      const fork = (snapshot.result as OrchestrationReadModel).threads.find(
        (thread) => thread.id === `fork-${operationId}`,
      );
      expect(fork?.branch).toBe("t3code-abcdef12");
      expect(fork?.worktreePath).toBeTruthy();
      expect(
        execFileSync("git", ["-C", fork!.worktreePath!, "branch", "--show-current"], {
          encoding: "utf8",
        }).trim(),
      ).toBe(fork?.branch);
      const binding = database
        .prepare("SELECT runtime_payload_json FROM provider_session_runtime WHERE thread_id = ?")
        .get(fork!.id);
      expect(JSON.parse(String(binding?.runtime_payload_json))).toMatchObject({
        cwd: fork!.worktreePath,
      });
    } finally {
      database.close();
    }
  }, 60_000);
});
