import type { TerminalEvent, TerminalSessionSnapshot } from "@t3tools/contracts";
import {
  DEFAULT_TERMINAL_ID,
  ORCHESTRATION_WS_METHODS,
  PROJECT_READ_FILE_MAX_SIZE,
  WS_CHANNELS,
  WS_METHODS,
  type OrchestrationReadModel,
} from "@t3tools/contracts";
import { Effect } from "effect";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { GitCommandError, GitManagerError } from "./git/Errors.ts";
import { type GitManagerShape } from "./git/Services/GitManager.ts";
import { withProviderThreadAccess } from "./provider/providerThreadAccess.ts";
import { resolveWorkspaceReadPath } from "./wsServer";
import {
  connectAndAwaitWelcome,
  createWsServerTestHarness,
  MockTerminalManager,
  sendRequest,
  TestRealPathError,
  waitForPush,
} from "./wsServer.testHarness.ts";

describe("WebSocket Server", () => {
  const h = createWsServerTestHarness();
  const { connections, makeTempDir, sha256Hex, createTestServer, closeTestServer } = h;

  it("returns checkout conflicts as structured recovery data without a stack trace", async () => {
    const cwd = makeTempDir("f5-checkout-conflict-");
    fs.mkdirSync(path.join(cwd, ".git"));
    const checkoutConflict = { cwd, branch: "main", files: ["index.css"] };
    h.server = await createTestServer({
      gitCore: {
        listBranches: () => Effect.die("unused"),
        initRepo: () => Effect.die("unused"),
        pullCurrentBranch: () => Effect.die("unused"),
        checkoutBranch: () =>
          Effect.fail(
            new GitCommandError({
              cwd: checkoutConflict.cwd,
              operation: "GitCore.checkoutBranch.checkout",
              command: "git checkout main --",
              detail: "error: Your local changes would be overwritten by checkout.",
              checkoutConflict,
            }),
          ),
      },
    });
    const addr = h.server.address();
    const port = typeof addr === "object" && addr !== null ? addr.port : 0;
    const [ws] = await connectAndAwaitWelcome(port);
    connections.push(ws);
    const response = await sendRequest(ws, WS_METHODS.gitCheckout, {
      cwd: checkoutConflict.cwd,
      branch: "main",
    });
    expect(response.error).toEqual({
      code: "GitCheckoutConflict",
      message: `Local changes in ${checkoutConflict.cwd} would be overwritten by switching to 'main'.`,
      checkoutConflict,
    });
  });

  it("keeps checkout conflict details in ordinary failures from other Git routes", async () => {
    const checkoutConflict = { cwd: "/repo", branch: "main", files: ["index.css"] };
    h.server = await createTestServer({
      gitCore: {
        listBranches: () => Effect.die("unused"),
        initRepo: () => Effect.die("unused"),
        pullCurrentBranch: () =>
          Effect.fail(
            new GitCommandError({
              cwd: "/repo",
              operation: "checkout during pull",
              command: "git checkout main --",
              detail: "Local changes in index.css would be overwritten",
              checkoutConflict,
            }),
          ),
      },
    });
    const addr = h.server.address();
    const port = typeof addr === "object" && addr !== null ? addr.port : 0;
    const [ws] = await connectAndAwaitWelcome(port);
    connections.push(ws);
    const response = await sendRequest(ws, WS_METHODS.gitPull, { cwd: "/repo" });
    expect(response.error?.code).toBeUndefined();
    expect(response.error?.checkoutConflict).toBeUndefined();
    expect(response.error?.message).toContain("index.css");
  });

  it("rejects GitHub CLI imports for invalid hosts or logins immediately", async () => {
    h.server = await createTestServer({ cwd: "/test" });
    const addr = h.server.address();
    const port = typeof addr === "object" && addr !== null ? addr.port : 0;
    const [ws] = await connectAndAwaitWelcome(port);
    connections.push(ws);
    for (const params of [
      { host: "https://github.com", login: "octocat" },
      { host: "github.com", login: "-not-a-login" },
    ]) {
      const response = await sendRequest(ws, WS_METHODS.githubAccountCliImport, params);
      expect(response.result).toBeUndefined();
      expect(response.error?.message).toContain("Invalid request format");
      expect(response.id).not.toBe("unknown");
    }
  });

  it("routes terminal RPC methods and broadcasts terminal events", async () => {
    const cwd = makeTempDir("t3code-ws-terminal-cwd-");
    const terminalManager = new MockTerminalManager();
    h.server = await createTestServer({
      cwd: "/test",
      terminalManager,
    });
    const addr = h.server.address();
    const port = typeof addr === "object" && addr !== null ? addr.port : 0;

    const [ws] = await connectAndAwaitWelcome(port);
    connections.push(ws);

    let release!: () => void;
    let entered!: () => void;
    const held = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const unlock = new Promise<void>((resolve) => {
      release = resolve;
    });
    const launch = Effect.runPromise(
      withProviderThreadAccess(
        "thread-1",
        Effect.promise(async () => {
          entered();
          await unlock;
        }),
      ),
    );
    await held;
    try {
      for (const method of [WS_METHODS.terminalOpen, WS_METHODS.terminalRestart]) {
        const liveTerminal = await sendRequest(ws, method, {
          threadId: "thread-1",
          cwd,
          cols: 100,
          rows: 24,
        });
        expect(liveTerminal.error).toBeUndefined();
        expect((liveTerminal.result as TerminalSessionSnapshot).threadId).toBe("thread-1");
      }
    } finally {
      release();
      await launch;
    }

    const open = await sendRequest(ws, WS_METHODS.terminalOpen, {
      threadId: "thread-1",
      cwd,
      cols: 100,
      rows: 24,
    });
    expect(open.error).toBeUndefined();
    expect((open.result as TerminalSessionSnapshot).threadId).toBe("thread-1");
    expect((open.result as TerminalSessionSnapshot).terminalId).toBe(DEFAULT_TERMINAL_ID);

    const write = await sendRequest(ws, WS_METHODS.terminalWrite, {
      threadId: "thread-1",
      data: "echo hello\n",
    });
    expect(write.error).toBeUndefined();

    const resize = await sendRequest(ws, WS_METHODS.terminalResize, {
      threadId: "thread-1",
      cols: 120,
      rows: 30,
    });
    expect(resize.error).toBeUndefined();

    const clear = await sendRequest(ws, WS_METHODS.terminalClear, {
      threadId: "thread-1",
    });
    expect(clear.error).toBeUndefined();

    const restart = await sendRequest(ws, WS_METHODS.terminalRestart, {
      threadId: "thread-1",
      cwd,
      cols: 120,
      rows: 30,
    });
    expect(restart.error).toBeUndefined();

    const close = await sendRequest(ws, WS_METHODS.terminalClose, {
      threadId: "thread-1",
      deleteHistory: true,
    });
    expect(close.error).toBeUndefined();

    const manualEvent: TerminalEvent = {
      epoch: "test",
      generation: 1,
      revision: 1,
      type: "output",
      threadId: "thread-1",
      terminalId: DEFAULT_TERMINAL_ID,
      createdAt: new Date().toISOString(),
      data: "manual test output\n",
    };
    terminalManager.emitEvent(manualEvent);

    const push = await waitForPush(
      ws,
      WS_CHANNELS.terminalEvent,
      (candidate) => (candidate.data as TerminalEvent).type === "output",
    );
    expect(push.type).toBe("push");
    expect(push.channel).toBe(WS_CHANNELS.terminalEvent);
  });

  it("detaches terminal event listener on stop for injected manager", async () => {
    const terminalManager = new MockTerminalManager();
    h.server = await createTestServer({
      cwd: "/test",
      terminalManager,
    });

    expect(terminalManager.subscriptionCount()).toBe(1);

    await closeTestServer();
    h.server = null;

    expect(terminalManager.subscriptionCount()).toBe(0);
  });

  it("returns validation errors for invalid terminal open params", async () => {
    h.server = await createTestServer({ cwd: "/test" });
    const addr = h.server.address();
    const port = typeof addr === "object" && addr !== null ? addr.port : 0;

    const [ws] = await connectAndAwaitWelcome(port);
    connections.push(ws);

    const response = await sendRequest(ws, WS_METHODS.terminalOpen, {
      threadId: "",
      cwd: "",
      cols: 1,
      rows: 1,
    });
    expect(response.error).toBeDefined();
  });

  it("returns errors for removed projects CRUD methods", async () => {
    h.server = await createTestServer({ cwd: "/test" });
    const addr = h.server.address();
    const port = typeof addr === "object" && addr !== null ? addr.port : 0;

    const [ws] = await connectAndAwaitWelcome(port);
    connections.push(ws);

    const listResponse = await sendRequest(ws, WS_METHODS.projectsList);
    expect(listResponse.result).toBeUndefined();
    expect(listResponse.error?.message).toContain("Invalid request format");

    const addResponse = await sendRequest(ws, WS_METHODS.projectsAdd, {
      cwd: "/tmp/project-a",
    });
    expect(addResponse.result).toBeUndefined();
    expect(addResponse.error?.message).toContain("Invalid request format");

    const removeResponse = await sendRequest(ws, WS_METHODS.projectsRemove, {
      id: "project-a",
    });
    expect(removeResponse.result).toBeUndefined();
    expect(removeResponse.error?.message).toContain("Invalid request format");
  });

  it("supports projects.searchEntries", async () => {
    const workspace = makeTempDir("t3code-ws-workspace-entries-");
    fs.mkdirSync(path.join(workspace, "src", "components"), { recursive: true });
    fs.writeFileSync(
      path.join(workspace, "src", "components", "Composer.tsx"),
      "export {};",
      "utf8",
    );
    fs.writeFileSync(path.join(workspace, "README.md"), "# test", "utf8");
    fs.mkdirSync(path.join(workspace, ".git"), { recursive: true });
    fs.writeFileSync(path.join(workspace, ".git", "HEAD"), "ref: refs/heads/main\n", "utf8");

    h.server = await createTestServer({ cwd: "/test" });
    const addr = h.server.address();
    const port = typeof addr === "object" && addr !== null ? addr.port : 0;

    const [ws] = await connectAndAwaitWelcome(port);
    connections.push(ws);

    const response = await sendRequest(ws, WS_METHODS.projectsSearchEntries, {
      cwd: workspace,
      query: "comp",
      limit: 10,
    });
    expect(response.error).toBeUndefined();
    expect(response.result).toEqual({
      entries: expect.arrayContaining([
        expect.objectContaining({ path: "src/components", kind: "directory" }),
        expect.objectContaining({ path: "src/components/Composer.tsx", kind: "file" }),
      ]),
      truncated: false,
    });
  });

  it("creates a committed project from a name in the configured projects folder", async () => {
    const projectsRoot = makeTempDir("f5-ws-new-projects-");
    fs.mkdirSync(path.join(projectsRoot, "my-app"));
    h.server = await createTestServer({ cwd: "/test" });
    const addr = h.server.address();
    const port = typeof addr === "object" && addr !== null ? addr.port : 0;
    const [ws] = await connectAndAwaitWelcome(port);
    connections.push(ws);
    expect(
      (
        await sendRequest(ws, WS_METHODS.serverUpdateSettings, {
          projectsRoot,
          gitAuthorName: "F5 Test",
          gitAuthorEmail: "f5@example.com",
        })
      ).error,
    ).toBeUndefined();

    const response = await sendRequest(ws, WS_METHODS.projectsCreateNew, { name: "My App" });
    expect(response.error).toBeUndefined();
    const result = response.result as { projectId: string; workspaceRoot: string; warning: null };
    // The taken name gets a suffix rather than reusing a folder that already exists.
    expect(result.workspaceRoot).toBe(path.join(projectsRoot, "my-app-2"));
    expect(result.warning).toBeNull();
    expect(
      execFileSync("git", ["log", "--format=%s"], { cwd: result.workspaceRoot }).toString().trim(),
    ).toBe("Initial commit");
    const snapshot = await sendRequest(ws, ORCHESTRATION_WS_METHODS.getSnapshot);
    expect(
      (snapshot.result as OrchestrationReadModel).projects.find(
        (project) => project.id === result.projectId,
      ),
    ).toMatchObject({ title: "My App", workspaceRoot: result.workspaceRoot, kind: "standard" });
  });

  it("finds the projects whose GitHub remote names a repository", async () => {
    const repo = (remote: string) => {
      const folder = makeTempDir("f5-ws-find-repo-");
      execFileSync("git", ["init", "-q"], { cwd: folder });
      execFileSync("git", ["remote", "add", "origin", remote], { cwd: folder });
      return folder;
    };
    const matching = repo("git@github.com:Lopes-Felipe/F5.git");
    const other = repo("https://github.com/lopes-felipe/f5-docs.git");
    h.server = await createTestServer({ cwd: "/test" });
    const addr = h.server.address();
    const port = typeof addr === "object" && addr !== null ? addr.port : 0;
    const [ws] = await connectAndAwaitWelcome(port);
    connections.push(ws);
    for (const [projectId, workspaceRoot] of [
      ["project-find-match", matching],
      ["project-find-other", other],
    ] as const) {
      const created = await sendRequest(ws, ORCHESTRATION_WS_METHODS.dispatchCommand, {
        type: "project.create",
        commandId: `cmd-${projectId}`,
        projectId,
        title: projectId,
        workspaceRoot,
        defaultModel: "gpt-5-codex",
        createdAt: new Date().toISOString(),
      });
      expect(created.error).toBeUndefined();
    }

    const response = await sendRequest(ws, WS_METHODS.projectsFindByRepository, {
      owner: "lopes-felipe",
      name: "f5",
    });
    expect(response.error).toBeUndefined();
    expect(response.result).toEqual([
      { projectId: "project-find-match", title: "project-find-match", workspaceRoot: matching },
    ]);
  });

  it("keeps file and Git requests below the scratch root inside one thread folder", async () => {
    const stateDir = makeTempDir("f5-ws-scratch-state-");
    const folder = path.join(stateDir, "scratch", "2026-10-22-notes-abc12345");
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(path.join(folder, "notes.md"), "# notes", "utf8");
    h.server = await createTestServer({ cwd: "/test", stateDir });
    const addr = h.server.address();
    const port = typeof addr === "object" && addr !== null ? addr.port : 0;
    const [ws] = await connectAndAwaitWelcome(port);
    connections.push(ws);

    const own = await sendRequest(ws, WS_METHODS.projectsSearchEntries, {
      cwd: folder,
      query: "notes",
      limit: 10,
    });
    expect(own.error).toBeUndefined();
    const shared = await sendRequest(ws, WS_METHODS.projectsSearchEntries, {
      cwd: path.join(stateDir, "scratch"),
      query: "notes",
      limit: 10,
    });
    expect(shared.error?.message).toContain("not a workspace");
    const status = await sendRequest(ws, WS_METHODS.gitStatus, { cwd: folder });
    expect(status.error?.message).toContain("no Git repository");
  });

  it("loads checked-in project defaults through a registered project identity", async () => {
    const workspace = makeTempDir("f5-ws-project-config-");
    fs.writeFileSync(
      path.join(workspace, "f5.json"),
      JSON.stringify({ defaultThreadEnvMode: "worktree", scripts: [{ command: "ignored" }] }),
      "utf8",
    );
    h.server = await createTestServer({ cwd: "/test" });
    const addr = h.server.address();
    const port = typeof addr === "object" && addr !== null ? addr.port : 0;
    const [ws] = await connectAndAwaitWelcome(port);
    connections.push(ws);

    const projectId = "project-checked-in-config";
    const createdAt = new Date().toISOString();
    const created = await sendRequest(ws, ORCHESTRATION_WS_METHODS.dispatchCommand, {
      type: "project.create",
      commandId: "cmd-project-checked-in-config",
      projectId,
      title: "Checked-in config",
      workspaceRoot: workspace,
      defaultModel: "gpt-5-codex",
      createdAt,
    });
    expect(created.error).toBeUndefined();

    const response = await sendRequest(ws, WS_METHODS.projectsGetCheckedInConfig, { projectId });
    expect(response.error).toBeUndefined();
    expect(response.result).toMatchObject({
      projectId,
      sourceFile: "f5.json",
      defaultThreadEnvMode: "worktree",
      iconPath: null,
      diagnostics: [expect.objectContaining({ field: "scripts" })],
    });
  });

  it("searches project contents through registered identities", async () => {
    const workspace = makeTempDir("f5-ws-content-search-");
    fs.mkdirSync(path.join(workspace, "src"), { recursive: true });
    fs.writeFileSync(
      path.join(workspace, "src", "unicode.ts"),
      "export const value = '😀 café needle';\n",
      "utf8",
    );

    h.server = await createTestServer({ cwd: "/test" });
    const addr = h.server.address();
    const port = typeof addr === "object" && addr !== null ? addr.port : 0;
    const [ws] = await connectAndAwaitWelcome(port);
    connections.push(ws);

    const createdAt = new Date().toISOString();
    const created = await sendRequest(ws, ORCHESTRATION_WS_METHODS.dispatchCommand, {
      type: "project.create",
      commandId: "cmd-content-project-create",
      projectId: "project-content",
      title: "Content Project",
      workspaceRoot: workspace,
      defaultModel: "gpt-5-codex",
      createdAt,
    });
    expect(created.error).toBeUndefined();

    const response = await sendRequest(ws, WS_METHODS.projectsSearchContents, {
      requestId: "content-search-1",
      projectId: "project-content",
      query: "café",
      limit: 500,
      caseSensitive: false,
      wholeWord: false,
      useRegex: false,
    });
    expect(response.error).toBeUndefined();
    expect(response.result).toEqual(
      expect.objectContaining({
        requestId: "content-search-1",
        truncated: false,
        matches: [
          expect.objectContaining({
            path: "src/unicode.ts",
            lineNumber: 1,
            matchRanges: [{ start: 24, end: 28 }],
          }),
        ],
      }),
    );

    const unavailable = await sendRequest(ws, WS_METHODS.projectsSearchContents, {
      requestId: "content-search-outside",
      projectId: workspace,
      query: "needle",
      limit: 10,
      caseSensitive: false,
      wholeWord: false,
      useRegex: false,
    });
    expect(unavailable.result).toBeUndefined();
    expect(unavailable.error?.message).toBe("Project content search target is unavailable.");

    const cancelled = await sendRequest(ws, WS_METHODS.projectsCancelContentSearch, {
      requestId: "missing-content-search",
    });
    expect(cancelled.result).toEqual({ cancelled: false });
  });

  it("supports projects.listEntries", async () => {
    const workspace = makeTempDir("t3code-ws-workspace-list-entries-");
    fs.mkdirSync(path.join(workspace, "src", "components"), { recursive: true });
    fs.writeFileSync(path.join(workspace, "src", "components", "Composer.tsx"), "export {};");
    fs.writeFileSync(path.join(workspace, "README.md"), "# test", "utf8");
    fs.mkdirSync(path.join(workspace, ".git"), { recursive: true });
    fs.writeFileSync(path.join(workspace, ".git", "HEAD"), "ref: refs/heads/main\n", "utf8");

    h.server = await createTestServer({ cwd: "/test" });
    const addr = h.server.address();
    const port = typeof addr === "object" && addr !== null ? addr.port : 0;

    const [ws] = await connectAndAwaitWelcome(port);
    connections.push(ws);

    const response = await sendRequest(ws, WS_METHODS.projectsListEntries, {
      cwd: workspace,
    });

    expect(response.error).toBeUndefined();
    expect(response.result).toEqual({
      entries: expect.arrayContaining([
        expect.objectContaining({ path: "src", kind: "directory" }),
        expect.objectContaining({ path: "src/components", kind: "directory" }),
        expect.objectContaining({ path: "src/components/Composer.tsx", kind: "file" }),
        expect.objectContaining({ path: "README.md", kind: "file" }),
      ]),
      truncated: false,
      totalEntries: 4,
    });
  });

  it("supports projects.writeFile within the workspace root", async () => {
    const workspace = makeTempDir("t3code-ws-write-file-");

    h.server = await createTestServer({ cwd: "/test" });
    const addr = h.server.address();
    const port = typeof addr === "object" && addr !== null ? addr.port : 0;

    const [ws] = await connectAndAwaitWelcome(port);
    connections.push(ws);

    const response = await sendRequest(ws, WS_METHODS.projectsWriteFile, {
      cwd: workspace,
      relativePath: "plans/effect-rpc.md",
      condition: { type: "create" },
      contents: "# Plan\n\n- step 1\n",
    });

    expect(response.error).toBeUndefined();
    expect(response.result).toEqual({
      relativePath: "plans/effect-rpc.md",
      byteLength: Buffer.byteLength("# Plan\n\n- step 1\n"),
      contentSha256: sha256Hex("# Plan\n\n- step 1\n"),
    });
    expect(fs.readFileSync(path.join(workspace, "plans", "effect-rpc.md"), "utf8")).toBe(
      "# Plan\n\n- step 1\n",
    );
  });

  it("rejects stale projects.writeFile precondition hashes", async () => {
    const workspace = makeTempDir("t3code-ws-write-file-conflict-");
    fs.mkdirSync(path.join(workspace, "plans"), { recursive: true });
    fs.writeFileSync(path.join(workspace, "plans", "effect-rpc.md"), "original\n", "utf8");

    h.server = await createTestServer({ cwd: "/test" });
    const addr = h.server.address();
    const port = typeof addr === "object" && addr !== null ? addr.port : 0;

    const [ws] = await connectAndAwaitWelcome(port);
    connections.push(ws);

    const response = await sendRequest(ws, WS_METHODS.projectsWriteFile, {
      cwd: workspace,
      relativePath: "plans/effect-rpc.md",
      contents: "next\n",
      condition: { type: "match", contentSha256: sha256Hex("stale\n") },
    });

    expect(response.result).toMatchObject({ conflict: true });
    expect(response.error).toBeUndefined();
    expect(fs.readFileSync(path.join(workspace, "plans", "effect-rpc.md"), "utf8")).toBe(
      "original\n",
    );
  });

  it("rejects projects.writeFile precondition hashes for oversized files without reading them", async () => {
    const workspace = makeTempDir("t3code-ws-write-file-large-precondition-");
    fs.writeFileSync(
      path.join(workspace, "large.txt"),
      Buffer.alloc(PROJECT_READ_FILE_MAX_SIZE + 1, "a"),
    );

    h.server = await createTestServer({ cwd: "/test" });
    const addr = h.server.address();
    const port = typeof addr === "object" && addr !== null ? addr.port : 0;

    const [ws] = await connectAndAwaitWelcome(port);
    connections.push(ws);

    const response = await sendRequest(ws, WS_METHODS.projectsWriteFile, {
      cwd: workspace,
      relativePath: "large.txt",
      contents: "next\n",
      condition: { type: "match", contentSha256: sha256Hex("stale\n") },
    });

    expect(response.result).toMatchObject({ conflict: true });
    expect(response.error).toBeUndefined();
    expect(fs.statSync(path.join(workspace, "large.txt")).size).toBe(
      PROJECT_READ_FILE_MAX_SIZE + 1,
    );
  });

  it("rejects projects.writeFile paths outside the workspace root", async () => {
    const workspace = makeTempDir("t3code-ws-write-file-reject-");

    h.server = await createTestServer({ cwd: "/test" });
    const addr = h.server.address();
    const port = typeof addr === "object" && addr !== null ? addr.port : 0;

    const [ws] = await connectAndAwaitWelcome(port);
    connections.push(ws);

    const response = await sendRequest(ws, WS_METHODS.projectsWriteFile, {
      cwd: workspace,
      relativePath: "../escape.md",
      condition: { type: "create" },
      contents: "# no\n",
    });

    expect(response.result).toBeUndefined();
    expect(response.error?.message).toContain(
      "Workspace file path must stay within the project root.",
    );
    expect(fs.existsSync(path.join(workspace, "..", "escape.md"))).toBe(false);
  });

  it("rejects symlink escapes for projects.writeFile", async () => {
    const workspace = makeTempDir("t3code-ws-write-file-symlink-");
    const outside = makeTempDir("t3code-ws-write-file-outside-");
    fs.symlinkSync(outside, path.join(workspace, "outside-link"));

    h.server = await createTestServer({ cwd: "/test" });
    const addr = h.server.address();
    const port = typeof addr === "object" && addr !== null ? addr.port : 0;

    const [ws] = await connectAndAwaitWelcome(port);
    connections.push(ws);

    const response = await sendRequest(ws, WS_METHODS.projectsWriteFile, {
      cwd: workspace,
      relativePath: "outside-link/escape.md",
      condition: { type: "create" },
      contents: "# no\n",
    });

    expect(response.result).toBeUndefined();
    expect(response.error?.message).toContain(
      "Workspace file path must stay within the project root.",
    );
    expect(fs.existsSync(path.join(outside, "escape.md"))).toBe(false);
  });

  it("supports projects.readFile within the workspace root", async () => {
    const workspace = makeTempDir("t3code-ws-read-file-");
    fs.mkdirSync(path.join(workspace, "plans"), { recursive: true });
    fs.writeFileSync(
      path.join(workspace, "plans", "effect-rpc.md"),
      "# Plan\n\n- step 1\n",
      "utf8",
    );

    h.server = await createTestServer({ cwd: "/test" });
    const addr = h.server.address();
    const port = typeof addr === "object" && addr !== null ? addr.port : 0;

    const [ws] = await connectAndAwaitWelcome(port);
    connections.push(ws);

    const response = await sendRequest(ws, WS_METHODS.projectsReadFile, {
      cwd: workspace,
      relativePath: "plans/effect-rpc.md",
    });

    expect(response.error).toBeUndefined();
    expect(response.result).toEqual({
      workspaceIdentity: fs.realpathSync(workspace),
      fileIdentity: fs.realpathSync(path.join(workspace, "plans", "effect-rpc.md")),
      relativePath: "plans/effect-rpc.md",
      contents: "# Plan\n\n- step 1\n",
      byteLength: Buffer.byteLength("# Plan\n\n- step 1\n"),
      truncated: false,
      contentSha256: sha256Hex("# Plan\n\n- step 1\n"),
    });
  });

  it("reads an external preview through a canonicalized parent without changing the project root", async () => {
    const workspace = makeTempDir("t3code-preview-project-");
    const external = makeTempDir("t3code-preview-external-");
    const aliasRoot = makeTempDir("t3code-preview-alias-");
    const alias = path.join(aliasRoot, "external");
    fs.writeFileSync(path.join(external, "report.json"), '{"images":8}', "utf8");
    fs.symlinkSync(external, alias, "dir");
    h.server = await createTestServer({ cwd: workspace });
    const addr = h.server.address();
    const port = typeof addr === "object" && addr !== null ? addr.port : 0;
    const [ws] = await connectAndAwaitWelcome(port);
    connections.push(ws);

    const response = await sendRequest(ws, WS_METHODS.projectsReadFile, {
      cwd: alias,
      relativePath: "report.json",
    });
    expect(response.error).toBeUndefined();
    expect(response.result).toMatchObject({
      workspaceIdentity: fs.realpathSync(external),
      fileIdentity: fs.realpathSync(path.join(external, "report.json")),
      contents: '{"images":8}',
      truncated: false,
    });
  });

  it("authorizes binary workspace files without reading their contents", async () => {
    const workspace = makeTempDir("t3code-ws-authorize-entry-");
    fs.writeFileSync(path.join(workspace, "image.bin"), Buffer.from([0, 1, 2, 3]));
    h.server = await createTestServer({ cwd: "/test" });
    const addr = h.server.address();
    const port = typeof addr === "object" && addr !== null ? addr.port : 0;
    const [ws] = await connectAndAwaitWelcome(port);
    connections.push(ws);

    const response = await sendRequest(ws, WS_METHODS.projectsAuthorizeEntry, {
      cwd: workspace,
      relativePath: "image.bin",
      kind: "file",
    });
    expect(response.error).toBeUndefined();
    expect(response.result).toEqual({ relativePath: "image.bin", kind: "file" });
  });

  it("rejects changed kinds and symlink escapes when authorizing workspace entries", async () => {
    const workspace = makeTempDir("t3code-ws-authorize-entry-symlink-");
    const outside = makeTempDir("t3code-ws-authorize-entry-outside-");
    fs.mkdirSync(path.join(workspace, "docs"));
    fs.writeFileSync(path.join(outside, "secret.txt"), "outside\n", "utf8");
    fs.symlinkSync(path.join(outside, "secret.txt"), path.join(workspace, "secret-link.txt"));
    h.server = await createTestServer({ cwd: "/test" });
    const addr = h.server.address();
    const port = typeof addr === "object" && addr !== null ? addr.port : 0;
    const [ws] = await connectAndAwaitWelcome(port);
    connections.push(ws);

    const changedKind = await sendRequest(ws, WS_METHODS.projectsAuthorizeEntry, {
      cwd: workspace,
      relativePath: "docs",
      kind: "file",
    });
    expect(changedKind.error?.message).toContain("Workspace entry type changed: docs");

    const symlinkEscape = await sendRequest(ws, WS_METHODS.projectsAuthorizeEntry, {
      cwd: workspace,
      relativePath: "secret-link.txt",
      kind: "file",
    });
    expect(symlinkEscape.error?.message).toContain(
      "Workspace file path must stay within the project root.",
    );
  });

  it("resolves projects.readFile targets to the validated real path before reading", async () => {
    const workspace = makeTempDir("t3code-ws-read-file-realpath-");
    fs.mkdirSync(path.join(workspace, "docs"), { recursive: true });
    fs.writeFileSync(path.join(workspace, "docs", "guide.md"), "# Guide\n", "utf8");
    fs.symlinkSync(path.join(workspace, "docs", "guide.md"), path.join(workspace, "guide-link.md"));

    const resolved = await Effect.runPromise(
      resolveWorkspaceReadPath({
        workspaceRoot: workspace,
        relativePath: "guide-link.md",
        path: path as never,
        fileSystem: {
          realPath: (targetPath: string) =>
            Effect.tryPromise({
              try: () => fs.promises.realpath(targetPath),
              catch: (cause) => new TestRealPathError({ cause }),
            }),
        } as never,
      }),
    );

    expect(resolved.relativePath).toBe("guide-link.md");
    expect(resolved.absolutePath).toBe(
      await fs.promises.realpath(path.join(workspace, "guide-link.md")),
    );
  });

  it("rejects projects.readFile paths outside the workspace root", async () => {
    const workspace = makeTempDir("t3code-ws-read-file-reject-");

    h.server = await createTestServer({ cwd: "/test" });
    const addr = h.server.address();
    const port = typeof addr === "object" && addr !== null ? addr.port : 0;

    const [ws] = await connectAndAwaitWelcome(port);
    connections.push(ws);

    const response = await sendRequest(ws, WS_METHODS.projectsReadFile, {
      cwd: workspace,
      relativePath: "../escape.md",
    });

    expect(response.result).toBeUndefined();
    expect(response.error?.message).toContain(
      "Workspace file path must stay within the project root.",
    );
  });

  it("rejects symlink escapes for projects.readFile", async () => {
    const workspace = makeTempDir("t3code-ws-read-file-symlink-");
    const outside = makeTempDir("t3code-ws-read-file-outside-");
    fs.writeFileSync(path.join(outside, "secret.txt"), "outside\n", "utf8");
    fs.symlinkSync(path.join(outside, "secret.txt"), path.join(workspace, "secret-link.txt"));

    h.server = await createTestServer({ cwd: "/test" });
    const addr = h.server.address();
    const port = typeof addr === "object" && addr !== null ? addr.port : 0;

    const [ws] = await connectAndAwaitWelcome(port);
    connections.push(ws);

    const response = await sendRequest(ws, WS_METHODS.projectsReadFile, {
      cwd: workspace,
      relativePath: "secret-link.txt",
    });

    expect(response.result).toBeUndefined();
    expect(response.error?.message).toContain(
      "Workspace file path must stay within the project root.",
    );
  });

  it("returns a truncated preview for oversized text files in projects.readFile", async () => {
    const workspace = makeTempDir("t3code-ws-read-file-large-");
    fs.writeFileSync(
      path.join(workspace, "large.txt"),
      Buffer.alloc(PROJECT_READ_FILE_MAX_SIZE + 1, "a"),
    );

    h.server = await createTestServer({ cwd: "/test" });
    const addr = h.server.address();
    const port = typeof addr === "object" && addr !== null ? addr.port : 0;

    const [ws] = await connectAndAwaitWelcome(port);
    connections.push(ws);

    const response = await sendRequest(ws, WS_METHODS.projectsReadFile, {
      cwd: workspace,
      relativePath: "large.txt",
    });

    expect(response.error).toBeUndefined();
    expect(response.result).toEqual({
      workspaceIdentity: fs.realpathSync(workspace),
      fileIdentity: fs.realpathSync(path.join(workspace, "large.txt")),
      relativePath: "large.txt",
      contents: "a".repeat(PROJECT_READ_FILE_MAX_SIZE),
      byteLength: PROJECT_READ_FILE_MAX_SIZE + 1,
      truncated: true,
    });
  });

  it("returns not found errors for missing projects.readFile targets", async () => {
    const workspace = makeTempDir("t3code-ws-read-file-missing-");

    h.server = await createTestServer({ cwd: "/test" });
    const addr = h.server.address();
    const port = typeof addr === "object" && addr !== null ? addr.port : 0;

    const [ws] = await connectAndAwaitWelcome(port);
    connections.push(ws);

    const response = await sendRequest(ws, WS_METHODS.projectsReadFile, {
      cwd: workspace,
      relativePath: "missing.txt",
    });

    expect(response.result).toBeUndefined();
    expect(response.error?.message).toContain("File not found: missing.txt");
  });

  it("rejects binary files for projects.readFile", async () => {
    const workspace = makeTempDir("t3code-ws-read-file-binary-");
    fs.writeFileSync(path.join(workspace, "image.bin"), Buffer.from([0, 1, 2, 3]));

    h.server = await createTestServer({ cwd: "/test" });
    const addr = h.server.address();
    const port = typeof addr === "object" && addr !== null ? addr.port : 0;

    const [ws] = await connectAndAwaitWelcome(port);
    connections.push(ws);

    const response = await sendRequest(ws, WS_METHODS.projectsReadFile, {
      cwd: workspace,
      relativePath: "image.bin",
    });

    expect(response.result).toBeUndefined();
    expect(response.error?.message).toContain("Binary file cannot be displayed: image.bin");
  });

  it("rejects directories for projects.readFile", async () => {
    const workspace = makeTempDir("t3code-ws-read-file-directory-");
    fs.mkdirSync(path.join(workspace, "notes"), { recursive: true });

    h.server = await createTestServer({ cwd: "/test" });
    const addr = h.server.address();
    const port = typeof addr === "object" && addr !== null ? addr.port : 0;

    const [ws] = await connectAndAwaitWelcome(port);
    connections.push(ws);

    const response = await sendRequest(ws, WS_METHODS.projectsReadFile, {
      cwd: workspace,
      relativePath: "notes",
    });

    expect(response.result).toBeUndefined();
    expect(response.error?.message).toContain("Path is a directory: notes");
  });

  it("routes git core methods over websocket", async () => {
    const listBranches = vi.fn(() =>
      Effect.succeed({
        branches: [],
        isRepo: false,
        hasOriginRemote: false,
      }),
    );
    const initRepo = vi.fn(() => Effect.void);
    const pullCurrentBranch = vi.fn(() =>
      Effect.fail(
        new GitCommandError({
          operation: "GitCore.test.pullCurrentBranch",
          detail: "No upstream configured",
          command: "git pull",
          cwd: "/repo/path",
        }),
      ),
    );

    h.server = await createTestServer({
      cwd: "/test",
      gitCore: {
        listBranches,
        initRepo,
        pullCurrentBranch,
      },
    });
    const addr = h.server.address();
    const port = typeof addr === "object" && addr !== null ? addr.port : 0;

    const [ws] = await connectAndAwaitWelcome(port);
    connections.push(ws);

    const listResponse = await sendRequest(ws, WS_METHODS.gitListBranches, { cwd: "/repo/path" });
    expect(listResponse.error).toBeUndefined();
    expect(listResponse.result).toEqual({ branches: [], isRepo: false, hasOriginRemote: false });
    expect(listBranches).toHaveBeenCalledWith({ cwd: "/repo/path" });

    const initResponse = await sendRequest(ws, WS_METHODS.gitInit, { cwd: "/repo/path" });
    expect(initResponse.error).toBeUndefined();
    expect(initRepo).toHaveBeenCalledWith({ cwd: "/repo/path" });

    const pullResponse = await sendRequest(ws, WS_METHODS.gitPull, { cwd: "/repo/path" });
    expect(pullResponse.result).toBeUndefined();
    expect(pullResponse.error?.message).toContain("No upstream configured");
    expect(pullCurrentBranch).toHaveBeenCalledWith("/repo/path");
  });

  it("supports git.status over websocket", async () => {
    const statusResult = {
      branch: "feature/test",
      hasWorkingTreeChanges: true,
      workingTree: {
        files: [{ path: "src/index.ts", insertions: 7, deletions: 2 }],
        insertions: 7,
        deletions: 2,
      },
      hasUpstream: false,
      aheadCount: 0,
      behindCount: 0,
      pr: null,
    };

    const status = vi.fn(() => Effect.succeed(statusResult));
    const runStackedAction = vi.fn(() => Effect.void as any);
    const resolvePullRequest = vi.fn(() => Effect.void as any);
    const preparePullRequestThread = vi.fn(() => Effect.void as any);
    const gitManager: GitManagerShape = {
      branchPullRequest: () => Effect.succeed(null),
      status,
      resolvePullRequest,
      preparePullRequestThread,
      runStackedAction,
    };

    h.server = await createTestServer({ cwd: "/test", gitManager });
    const addr = h.server.address();
    const port = typeof addr === "object" && addr !== null ? addr.port : 0;

    const [ws] = await connectAndAwaitWelcome(port);
    connections.push(ws);

    const response = await sendRequest(ws, WS_METHODS.gitStatus, {
      cwd: "/test",
    });
    expect(response.error).toBeUndefined();
    expect(response.result).toEqual(statusResult);
    expect(status).toHaveBeenCalledWith({ cwd: "/test" });
  });

  it("supports git pull request routing over websocket", async () => {
    const resolvePullRequestResult = {
      pullRequest: {
        number: 42,
        title: "PR thread flow",
        url: "https://github.com/pingdotgg/codething-mvp/pull/42",
        baseBranch: "main",
        headBranch: "feature/pr-threads",
        state: "open" as const,
      },
    };
    const preparePullRequestThreadResult = {
      ...resolvePullRequestResult,
      branch: "feature/pr-threads",
      worktreePath: "/tmp/pr-threads",
    };

    const gitManager: GitManagerShape = {
      branchPullRequest: () => Effect.succeed(null),
      status: vi.fn(() => Effect.void as any),
      resolvePullRequest: vi.fn(() => Effect.succeed(resolvePullRequestResult)),
      preparePullRequestThread: vi.fn(() => Effect.succeed(preparePullRequestThreadResult)),
      runStackedAction: vi.fn(() => Effect.void as any),
    };

    h.server = await createTestServer({ cwd: "/test", gitManager });
    const addr = h.server.address();
    const port = typeof addr === "object" && addr !== null ? addr.port : 0;

    const [ws] = await connectAndAwaitWelcome(port);
    connections.push(ws);

    const resolveResponse = await sendRequest(ws, WS_METHODS.gitResolvePullRequest, {
      cwd: "/test",
      reference: "#42",
    });
    expect(resolveResponse.error).toBeUndefined();
    expect(resolveResponse.result).toEqual(resolvePullRequestResult);

    const prepareResponse = await sendRequest(ws, WS_METHODS.gitPreparePullRequestThread, {
      cwd: "/test",
      reference: "42",
      mode: "worktree",
    });
    expect(prepareResponse.error).toBeUndefined();
    expect(prepareResponse.result).toEqual(preparePullRequestThreadResult);
    expect(gitManager.resolvePullRequest).toHaveBeenCalledWith({
      cwd: "/test",
      reference: "#42",
    });
    expect(gitManager.preparePullRequestThread).toHaveBeenCalledWith({
      cwd: "/test",
      reference: "42",
      mode: "worktree",
    });
  });

  it("returns errors from git.runStackedAction", async () => {
    const runStackedAction = vi.fn(() =>
      Effect.fail(
        new GitManagerError({
          operation: "GitManager.test.runStackedAction",
          detail: "Cannot push from detached HEAD.",
        }),
      ),
    );
    const gitManager: GitManagerShape = {
      branchPullRequest: () => Effect.succeed(null),
      status: vi.fn(() => Effect.void as any),
      resolvePullRequest: vi.fn(() => Effect.void as any),
      preparePullRequestThread: vi.fn(() => Effect.void as any),
      runStackedAction,
    };

    h.server = await createTestServer({ cwd: "/test", gitManager });
    const addr = h.server.address();
    const port = typeof addr === "object" && addr !== null ? addr.port : 0;

    const [ws] = await connectAndAwaitWelcome(port);
    connections.push(ws);

    const response = await sendRequest(ws, WS_METHODS.gitRunStackedAction, {
      cwd: "/test",
      action: "commit_push",
    });
    expect(response.result).toBeUndefined();
    expect(response.error?.message).toContain("detached HEAD");
    expect(runStackedAction).toHaveBeenCalledWith(
      {
        cwd: "/test",
        action: "commit_push",
      },
      expect.objectContaining({
        actionId: expect.any(String),
        progressReporter: expect.objectContaining({
          publish: expect.any(Function),
        }),
      }),
    );
  });
});
