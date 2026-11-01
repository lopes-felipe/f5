import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  DEFAULT_MODEL_BY_PROVIDER,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  F5_PROTOCOL_HEADER,
  F5_PROTOCOL_VERSION,
  F5_UPGRADE_REQUIRED_CLOSE_CODE,
  ORCHESTRATION_WS_METHODS,
  ProjectId,
  ThreadId,
  WS_CHANNELS,
  WS_METHODS,
  type OrchestrationReadModel,
  type OrchestrationThread,
  type WebSocketResponse,
} from "@t3tools/contracts";
import { Deferred, Effect, Layer, Option, Scope, Stream } from "effect";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import * as Http from "node:http";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import {
  ComputerAutomationBroker,
  ComputerAutomationBrokerRuntime,
} from "./computer/ComputerAutomationBroker";
import { DesktopComputerHost } from "./computer/DesktopComputerHost";
import { browserOpenSocketPath } from "./browser/BrowserOpenLauncher";
import { type OpenShape } from "./open";
import { makeSqlitePersistenceLive } from "./persistence/Layers/Sqlite";
import { WorkspaceTransition } from "./project/Services/WorkspaceTransition.ts";
import { WorktreePreparation } from "./project/Services/WorktreePreparation.ts";
import { ProviderService, type ProviderServiceShape } from "./provider/Services/ProviderService";
import {
  createServer,
  encodeResponseEncodeFailure,
  readWebSocketRequestId,
  serverStartingRejection,
} from "./wsServer";
import {
  asThreadId,
  asTurnId,
  channelsBySocket,
  connectAndAwaitWelcome,
  connectWs,
  createWsServerTestHarness,
  defaultOpenService,
  defaultProviderService,
  dequeue,
  requestPath,
  sendRequest,
  waitForPush,
} from "./wsServer.testHarness.ts";
import { SERVER_BOOTSTRAP } from "./wsServer/protocol";

describe("WebSocket Server", () => {
  const h = createWsServerTestHarness();
  const { connections, makeTempDir, createTestServer, closeTestServer } = h;

  it.skipIf(process.platform !== "darwin")(
    "starts the real broker when browser socket setup fails",
    async () => {
      const stateDir = makeTempDir("f5-browser-broker-blocked-");
      const socketPath = browserOpenSocketPath(stateDir);
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      vi.stubEnv("F5_DESKTOP_COMPUTER_HOST", "ipc");
      try {
        fs.mkdirSync(path.dirname(socketPath), { recursive: true });
        fs.writeFileSync(socketPath, "keep");
        h.server = await createTestServer({ stateDir, computerAccess: true });
        const address = h.server.address();
        const [ws] = await connectAndAwaitWelcome(
          typeof address === "object" && address ? address.port : 0,
        );
        connections.push(ws);
        expect(warn).toHaveBeenCalledWith(
          expect.stringContaining("listener unavailable"),
          expect.any(Error),
        );
        expect(fs.readFileSync(socketPath, "utf8")).toBe("keep");
      } finally {
        await closeTestServer();
        fs.rmSync(socketPath, { force: true });
        vi.unstubAllEnvs();
        warn.mockRestore();
      }
    },
  );

  it.each(['[{"appId":"private-sentinel"', '[{"tier":"future","appId":"x","projectId":"p"}]'])(
    "starts the real headless backend with invalid remembered grants: %s",
    async (contents) => {
      const stateDir = makeTempDir("f5-corrupt-grants-");
      fs.writeFileSync(path.join(stateDir, "computer-access.json"), contents);
      h.server = await createTestServer({ stateDir, computerAccess: true });
      const address = h.server.address();
      const [ws] = await connectAndAwaitWelcome(
        typeof address === "object" && address ? address.port : 0,
      );
      connections.push(ws);
      expect(fs.existsSync(path.join(stateDir, "computer-access.json"))).toBe(false);
      const saved = fs
        .readdirSync(stateDir)
        .find((name) => name.startsWith("computer-access.corrupt-"));
      expect(saved).toBeDefined();
      expect(fs.readFileSync(path.join(stateDir, saved!), "utf8")).toBe(contents);
    },
  );

  it.each([false, true])(
    "preview resume remains typed and only requires main approval for computer pause=%s",
    async (computerPaused) => {
      const ipc = Object.assign(new EventEmitter(), {
        connected: true,
        send: (_message: unknown, callback: (error: Error | null) => void) => {
          callback(null);
          return true;
        },
      });
      const host = new DesktopComputerHost("profile", "backend", ipc, true);
      const broker = new ComputerAutomationBrokerRuntime(host, {
        platform: "darwin",
        storage: { load: async () => [], save: async () => {} },
        resolve: async () => {
          throw new Error("Computer tools must not execute in this test.");
        },
      });
      const threadId = ThreadId.makeUnsafe("preview-with-computer-tools");
      broker.bindSession(threadId, "session", "claude");
      ipc.emit("message", {
        type: "status",
        status: { available: false, reason: "helper-missing" },
      });
      if (computerPaused) ipc.emit("message", { type: "pauseChanged", threadId, paused: true });
      try {
        h.server = await createTestServer({
          createServerFactory: () =>
            createServer().pipe(Effect.provideService(ComputerAutomationBroker, broker)),
        });
        const address = h.server.address();
        const [ws] = await connectAndAwaitWelcome(
          typeof address === "object" && address ? address.port : 0,
        );
        connections.push(ws);
        const response = await sendRequest(ws, WS_METHODS.previewAutomationSetPaused, {
          threadId,
          paused: false,
        });
        if (computerPaused) {
          expect(response.error?.message).toContain("computer running F5");
          expect(broker.pause.has(threadId)).toBe(true);
        } else expect(response.error).toBeUndefined();
      } finally {
        broker.close();
      }
    },
  );

  it("delivers native action summaries and suppresses uncorrelated IPC thumbnails", async () => {
    const ipc = Object.assign(new EventEmitter(), {
      connected: true,
      send: (_message: unknown, callback: (error: Error | null) => void) => {
        callback(null);
        return true;
      },
    });
    const host = new DesktopComputerHost("profile", "backend", ipc, true);
    const broker = new ComputerAutomationBrokerRuntime(host, {
      platform: "darwin",
      storage: { load: async () => [], save: async () => {} },
      resolve: async () => {
        throw new Error("No native action should execute in this transport test.");
      },
    });
    try {
      h.server = await createTestServer({
        createServerFactory: () =>
          createServer().pipe(Effect.provideService(ComputerAutomationBroker, broker)),
      });
      const address = h.server.address();
      const [ws] = await connectAndAwaitWelcome(
        typeof address === "object" && address ? address.port : 0,
      );
      connections.push(ws);
      const activity = {
        threadId: "fixture-thread",
        backend: "native",
        op: "activateApp",
        status: "completed",
        thumbnailDataUrl: "data:image/jpeg;base64,SYNTHETIC",
      };
      ipc.emit("message", { type: "activity", activity });
      const push = await waitForPush(ws, WS_CHANNELS.computerActivity);
      const { thumbnailDataUrl: _thumbnail, ...summary } = activity;
      expect(push.data).toEqual(summary);
      const failed = {
        threadId: "fixture-thread",
        backend: "native",
        op: "elementAction",
        status: "failed",
        outcome: "app-resolution-failed",
      };
      ipc.emit("message", { type: "activity", activity: failed });
      const failurePush = await waitForPush(ws, WS_CHANNELS.computerActivity);
      expect(failurePush.data).toEqual(failed);
    } finally {
      broker.close();
    }
  });

  it("cannot silently bind another address family over an occupied IPv4 port", async () => {
    const foreign = Http.createServer((_request, response) => {
      response.writeHead(403);
      response.end();
    });
    await new Promise<void>((resolve) => foreign.listen({ host: "127.0.0.1", port: 0 }, resolve));
    try {
      const address = foreign.address();
      if (!address || typeof address === "string") throw new Error("Fixture listener missing");
      await expect(createTestServer({ port: address.port })).rejects.toMatchObject({
        _tag: "ServerLifecycleError",
        operation: "httpServerListen",
      });
    } finally {
      await new Promise<void>((resolve, reject) =>
        foreign.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });

  it("sends welcome message on connect", async () => {
    h.server = await createTestServer({ cwd: "/test/project" });
    const addr = h.server.address();
    const port = typeof addr === "object" && addr !== null ? addr.port : 0;
    expect(port).toBeGreaterThan(0);
    expect(typeof addr === "object" && addr?.family).toBe("IPv4");

    const [ws, welcome] = await connectAndAwaitWelcome(port);
    connections.push(ws);

    expect(welcome.type).toBe("push");
    expect(welcome.data).toMatchObject({
      cwd: "/test/project",
      projectName: "project",
      profile: { isDefault: true, slug: "default", isActive: true },
    });
  });

  it("writes rpc and websocket observability records when enabled", async () => {
    const stateDir = makeTempDir("t3code-ws-observability-");
    h.server = await createTestServer({
      cwd: "/test/project",
      stateDir,
      observabilityEnabled: true,
    });
    const addr = h.server.address();
    const port = typeof addr === "object" && addr !== null ? addr.port : 0;

    const [ws] = await connectAndAwaitWelcome(port);
    connections.push(ws);

    const response = await sendRequest(ws, WS_METHODS.serverGetConfig);
    expect(response.error).toBeUndefined();

    await new Promise<void>((resolve) => {
      ws.once("close", () => resolve());
      ws.close();
    });
    connections.splice(connections.indexOf(ws), 1);
    await closeTestServer();
    h.server = null;

    const tracePath = path.join(stateDir, "logs", "observability", "traces.ndjson");
    const metricsPath = path.join(stateDir, "logs", "observability", "metrics.ndjson");

    expect(fs.existsSync(tracePath)).toBe(true);
    expect(fs.existsSync(metricsPath)).toBe(true);

    const traces = fs
      .readFileSync(tracePath, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { name: string; attributes: Record<string, unknown> });
    const metricSnapshots = fs
      .readFileSync(metricsPath, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map(
        (line) =>
          JSON.parse(line) as {
            metrics: Array<{
              id: string;
              attributes: Record<string, string>;
              value?: number;
            }>;
          },
      );

    expect(
      traces.some(
        (record) =>
          record.name === "rpc.server.getConfig" &&
          record.attributes["rpc.method"] === "server.getConfig",
      ),
    ).toBe(true);

    const latestSnapshot = metricSnapshots.at(-1);
    expect(latestSnapshot?.metrics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "t3_rpc_requests_total",
          attributes: {
            method: "server.getConfig",
            outcome: "success",
          },
        }),
        expect.objectContaining({
          id: "t3_websocket_connections_total",
          attributes: {
            event: "connect",
          },
          value: expect.any(Number),
        }),
        expect.objectContaining({
          id: "t3_websocket_connections_total",
          attributes: {
            event: "disconnect",
          },
          value: expect.any(Number),
        }),
      ]),
    );
    expect(
      latestSnapshot?.metrics.find(
        (metric) =>
          metric.id === "t3_websocket_connections_total" &&
          metric.attributes.event === "connect" &&
          typeof metric.value === "number",
      )?.value,
    ).toBeGreaterThanOrEqual(1);
    expect(
      latestSnapshot?.metrics.find(
        (metric) =>
          metric.id === "t3_websocket_connections_total" &&
          metric.attributes.event === "disconnect" &&
          typeof metric.value === "number",
      )?.value,
    ).toBeGreaterThanOrEqual(1);
  });

  it("does not write observability files when disabled", async () => {
    const stateDir = makeTempDir("t3code-ws-observability-disabled-");
    h.server = await createTestServer({
      cwd: "/test/project",
      stateDir,
      observabilityEnabled: false,
    });
    const addr = h.server.address();
    const port = typeof addr === "object" && addr !== null ? addr.port : 0;

    const [ws] = await connectAndAwaitWelcome(port);
    connections.push(ws);
    const response = await sendRequest(ws, WS_METHODS.serverGetConfig);
    expect(response.error).toBeUndefined();

    await closeTestServer();
    h.server = null;

    expect(fs.existsSync(path.join(stateDir, "logs", "observability", "traces.ndjson"))).toBe(
      false,
    );
    expect(fs.existsSync(path.join(stateDir, "logs", "observability", "metrics.ndjson"))).toBe(
      false,
    );
  });

  it("serves persisted attachments from stateDir", async () => {
    const stateDir = makeTempDir("t3code-state-attachments-");
    const attachmentPath = path.join(stateDir, "attachments", "thread-a", "message-a", "0.png");
    fs.mkdirSync(path.dirname(attachmentPath), { recursive: true });
    fs.writeFileSync(attachmentPath, Buffer.from("hello-attachment"));

    h.server = await createTestServer({ cwd: "/test/project", stateDir });
    const addr = h.server.address();
    const port = typeof addr === "object" && addr !== null ? addr.port : 0;
    expect(port).toBeGreaterThan(0);

    const response = await fetch(`http://127.0.0.1:${port}/attachments/thread-a/message-a/0.png`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("image/png");
    // Stored attachments are write-once, so remounts and gallery views reuse the cache.
    expect(response.headers.get("cache-control")).toBe("private, max-age=31536000, immutable");
    const bytes = Buffer.from(await response.arrayBuffer());
    expect(bytes).toEqual(Buffer.from("hello-attachment"));
  });

  it("serves persisted attachments for URL-encoded paths", async () => {
    const stateDir = makeTempDir("t3code-state-attachments-encoded-");
    const attachmentPath = path.join(
      stateDir,
      "attachments",
      "thread%20folder",
      "message%20folder",
      "file%20name.png",
    );
    fs.mkdirSync(path.dirname(attachmentPath), { recursive: true });
    fs.writeFileSync(attachmentPath, Buffer.from("hello-encoded-attachment"));

    h.server = await createTestServer({ cwd: "/test/project", stateDir });
    const addr = h.server.address();
    const port = typeof addr === "object" && addr !== null ? addr.port : 0;
    expect(port).toBeGreaterThan(0);

    const response = await fetch(
      `http://127.0.0.1:${port}/attachments/thread%20folder/message%20folder/file%20name.png`,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("image/png");
    const bytes = Buffer.from(await response.arrayBuffer());
    expect(bytes).toEqual(Buffer.from("hello-encoded-attachment"));
  });

  it("serves project favicons only through registered project identities", async () => {
    const workspaceRoot = makeTempDir("f5-ws-project-favicon-");
    fs.writeFileSync(path.join(workspaceRoot, "favicon.svg"), "<svg>registered</svg>", "utf8");
    const projectId = ProjectId.makeUnsafe("project-favicon-route");
    h.server = await createTestServer({ cwd: "/test/project" });
    const address = h.server.address();
    const port = typeof address === "object" && address !== null ? address.port : 0;
    const [socket] = await connectAndAwaitWelcome(port);
    connections.push(socket);

    const createProjectResponse = await sendRequest(
      socket,
      ORCHESTRATION_WS_METHODS.dispatchCommand,
      {
        type: "project.create",
        commandId: "cmd-project-favicon-route",
        projectId,
        title: "Favicon project",
        workspaceRoot,
        defaultModel: "gpt-5-codex",
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    );
    expect(createProjectResponse.error).toBeUndefined();

    const response = await fetch(
      `http://127.0.0.1:${port}/api/project-favicon?projectId=${projectId}`,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("private");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await response.text()).toBe("<svg>registered</svg>");

    const arbitraryRootResponse = await fetch(
      `http://127.0.0.1:${port}/api/project-favicon?projectId=${encodeURIComponent(workspaceRoot)}`,
    );
    expect(arbitraryRootResponse.status).toBe(404);
    await arbitraryRootResponse.arrayBuffer();
  });

  it("serves static index for root path", async () => {
    const stateDir = makeTempDir("t3code-state-static-root-");
    const staticDir = makeTempDir("t3code-static-root-");
    fs.writeFileSync(path.join(staticDir, "index.html"), "<h1>static-root</h1>", "utf8");

    h.server = await createTestServer({ cwd: "/test/project", stateDir, staticDir });
    const addr = h.server.address();
    const port = typeof addr === "object" && addr !== null ? addr.port : 0;
    expect(port).toBeGreaterThan(0);

    const response = await fetch(`http://127.0.0.1:${port}/`);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("static-root");
    expect(response.headers.get("cache-control")).toBe("no-cache");
    fs.writeFileSync(path.join(staticDir, "index.html"), "<h1>updated app</h1>", "utf8");
    const refreshed = await fetch(`http://127.0.0.1:${port}/index.html`, {
      headers: { "If-None-Match": "old-client" },
    });
    expect(refreshed.status).toBe(200);
    expect(refreshed.headers.get("cache-control")).toBe("no-cache");
    expect(await refreshed.text()).toContain("updated app");
  });

  it("streams app bundles with HEAD and immutable caching while missing bundles return 404", async () => {
    const stateDir = makeTempDir("f5-streamed-state-"),
      staticDir = makeTempDir("f5-streamed-app-");
    fs.mkdirSync(path.join(staticDir, "assets"));
    fs.writeFileSync(path.join(staticDir, "index.html"), "<h1>Application shell</h1>");
    fs.writeFileSync(
      path.join(staticDir, "assets", "main-abcdef12.js"),
      "globalThis.bundleLoaded = true;",
    );
    h.server = await createTestServer({ cwd: "/test/project", stateDir, staticDir });
    const address = h.server.address();
    const port = typeof address === "object" && address !== null ? address.port : 0;
    const bundle = await fetch(`http://127.0.0.1:${port}/assets/main-abcdef12.js`);
    expect(await bundle.text()).toBe("globalThis.bundleLoaded = true;");
    expect(bundle.headers.get("cache-control")).toContain("immutable");
    expect(bundle.headers.get("content-security-policy")).toBeNull();
    fs.writeFileSync(path.join(staticDir, "assets", "code-highlight-worker.js"), "// worker");
    const worker = await fetch(`http://127.0.0.1:${port}/assets/code-highlight-worker.js`);
    expect(worker.headers.get("cache-control")).toBe("no-cache");
    expect(await worker.text()).toBe("// worker");
    const head = await fetch(`http://127.0.0.1:${port}/assets/main-abcdef12.js`, {
      method: "HEAD",
    });
    expect(head.status).toBe(200);
    expect(head.headers.get("content-length")).toBe(
      String(Buffer.byteLength("globalThis.bundleLoaded = true;")),
    );
    expect(await head.text()).toBe("");
    for (const file of ["missing.js", "missing.css"]) {
      const missing = await fetch(`http://127.0.0.1:${port}/assets/${file}`, {
        headers: { Accept: "text/html" },
      });
      expect(missing.status).toBe(404);
      expect(await missing.text()).toBe("Not Found");
    }
    const navigation = await fetch(`http://127.0.0.1:${port}/thread/client-route`, {
      headers: { Accept: "text/html" },
    });
    expect(navigation.status).toBe(200);
    expect(await navigation.text()).toContain("Application shell");
    expect(navigation.headers.get("cache-control")).toBe("no-cache");
    const request = await fetch(`http://127.0.0.1:${port}/thread/client-route`, {
      headers: { Accept: "application/json" },
    });
    expect(request.status).toBe(404);
    await request.text();
  });

  it("rejects static path traversal attempts", async () => {
    const stateDir = makeTempDir("t3code-state-static-traversal-");
    const staticDir = makeTempDir("t3code-static-traversal-");
    fs.writeFileSync(path.join(staticDir, "index.html"), "<h1>safe</h1>", "utf8");

    h.server = await createTestServer({ cwd: "/test/project", stateDir, staticDir });
    const addr = h.server.address();
    const port = typeof addr === "object" && addr !== null ? addr.port : 0;
    expect(port).toBeGreaterThan(0);

    const response = await requestPath(port, "/..%2f..%2fetc/passwd");
    expect(response.statusCode).toBe(400);
    expect(response.body).toBe("Invalid static file path");
  });

  it("bootstraps the cwd project on startup when enabled", async () => {
    vi.spyOn(console, "log");
    const cwd = path.join(makeTempDir("t3code-bootstrap-"), "bootstrap-workspace");
    fs.mkdirSync(cwd);
    h.server = await createTestServer({
      cwd,
      autoBootstrapProjectFromCwd: true,
      logWebSocketEvents: true,
    });
    const addr = h.server.address();
    const port = typeof addr === "object" && addr !== null ? addr.port : 0;
    expect(port).toBeGreaterThan(0);

    const [ws, welcome] = await connectAndAwaitWelcome(port);
    connections.push(ws);
    expect(welcome.data).toEqual(
      expect.objectContaining({
        cwd,
        projectName: "bootstrap-workspace",
        bootstrapProjectId: expect.any(String),
        bootstrapThreadId: expect.any(String),
      }),
    );

    const snapshotResponse = await sendRequest(ws, ORCHESTRATION_WS_METHODS.getSnapshot);
    expect(snapshotResponse.error).toBeUndefined();
    const snapshot = snapshotResponse.result as {
      projects: Array<{
        id: string;
        workspaceRoot: string;
        title: string;
        defaultModel: string | null;
      }>;
      threads: Array<{
        id: string;
        projectId: string;
        title: string;
        model: string;
        branch: string | null;
        worktreePath: string | null;
      }>;
    };
    const bootstrapProjectId = (welcome.data as { bootstrapProjectId?: string }).bootstrapProjectId;
    const bootstrapThreadId = (welcome.data as { bootstrapThreadId?: string }).bootstrapThreadId;
    expect(bootstrapProjectId).toBeDefined();
    expect(bootstrapThreadId).toBeDefined();

    expect(snapshot.projects).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: bootstrapProjectId,
          workspaceRoot: cwd,
          title: "bootstrap-workspace",
          defaultModel: DEFAULT_MODEL_BY_PROVIDER.codex,
        }),
      ]),
    );
    expect(snapshot.threads).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: bootstrapThreadId,
          projectId: bootstrapProjectId,
          title: "New thread",
          model: DEFAULT_MODEL_BY_PROVIDER.codex,
          branch: null,
          worktreePath: null,
        }),
      ]),
    );
  });

  it("includes bootstrap ids in welcome when cwd project and thread already exist", async () => {
    vi.spyOn(console, "log");
    const stateDir = makeTempDir("t3code-state-bootstrap-existing-");
    const persistenceLayer = makeSqlitePersistenceLive(path.join(stateDir, "state.sqlite")).pipe(
      Layer.provide(NodeServices.layer),
    );
    const cwd = path.join(stateDir, "bootstrap-existing");
    fs.mkdirSync(cwd);

    h.server = await createTestServer({
      cwd,
      stateDir,
      persistenceLayer,
      autoBootstrapProjectFromCwd: true,
      logWebSocketEvents: true,
    });
    let addr = h.server.address();
    let port = typeof addr === "object" && addr !== null ? addr.port : 0;
    expect(port).toBeGreaterThan(0);

    const [firstWs, firstWelcome] = await connectAndAwaitWelcome(port);
    connections.push(firstWs);
    const firstBootstrapProjectId = (firstWelcome.data as { bootstrapProjectId?: string })
      .bootstrapProjectId;
    const firstBootstrapThreadId = (firstWelcome.data as { bootstrapThreadId?: string })
      .bootstrapThreadId;
    expect(firstBootstrapProjectId).toBeDefined();
    expect(firstBootstrapThreadId).toBeDefined();

    firstWs.close();
    await closeTestServer();
    h.server = null;

    h.server = await createTestServer({
      cwd,
      stateDir,
      persistenceLayer,
      autoBootstrapProjectFromCwd: true,
    });
    addr = h.server.address();
    port = typeof addr === "object" && addr !== null ? addr.port : 0;
    expect(port).toBeGreaterThan(0);

    const [secondWs, secondWelcome] = await connectAndAwaitWelcome(port);
    connections.push(secondWs);
    expect(secondWelcome.data).toEqual(
      expect.objectContaining({
        cwd,
        projectName: "bootstrap-existing",
        bootstrapProjectId: firstBootstrapProjectId,
        bootstrapThreadId: firstBootstrapThreadId,
      }),
    );
  });

  it("returns thread details from projections while orchestration runtime startup is still pending", async () => {
    const stateDir = makeTempDir("t3code-state-thread-details-pending-runtime-");
    const persistenceLayer = makeSqlitePersistenceLive(path.join(stateDir, "state.sqlite")).pipe(
      Layer.provide(NodeServices.layer),
    );
    const workspaceRoot = stateDir;

    h.server = await createTestServer({
      cwd: workspaceRoot,
      stateDir,
      persistenceLayer,
    });
    let addr = h.server.address();
    let port = typeof addr === "object" && addr !== null ? addr.port : 0;
    expect(port).toBeGreaterThan(0);

    const [seedWs] = await connectAndAwaitWelcome(port);
    connections.push(seedWs);

    const createProjectResponse = await sendRequest(
      seedWs,
      ORCHESTRATION_WS_METHODS.dispatchCommand,
      {
        type: "project.create",
        commandId: "cmd-project-pending-runtime-create",
        projectId: "project-pending-runtime",
        title: "Pending Runtime Project",
        workspaceRoot,
        defaultModel: "gpt-5-codex",
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    );
    expect(createProjectResponse.error).toBeUndefined();

    const createThreadResponse = await sendRequest(
      seedWs,
      ORCHESTRATION_WS_METHODS.dispatchCommand,
      {
        type: "thread.create",
        commandId: "cmd-thread-pending-runtime-create",
        threadId: "thread-pending-runtime",
        projectId: "project-pending-runtime",
        title: "Pending Runtime Thread",
        model: "gpt-5-codex",
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        branch: null,
        worktreePath: null,
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    );
    expect(createThreadResponse.error).toBeUndefined();

    await closeTestServer();
    h.server = null;

    vi.resetModules();
    vi.doMock("./serverLayers.ts", async () => {
      const actual = await vi.importActual<typeof import("./serverLayers.ts")>("./serverLayers.ts");
      const orchestrationEngineModule = await vi.importActual<
        typeof import("./orchestration/Services/OrchestrationEngine.ts")
      >("./orchestration/Services/OrchestrationEngine.ts");
      const orchestrationReactorModule = await vi.importActual<
        typeof import("./orchestration/Services/OrchestrationReactor.ts")
      >("./orchestration/Services/OrchestrationReactor.ts");
      const providerCommandReactorModule = await vi.importActual<
        typeof import("./orchestration/Services/ProviderCommandReactor.ts")
      >("./orchestration/Services/ProviderCommandReactor.ts");
      const providerTurnDeliveryWorkerModule = await vi.importActual<
        typeof import("./orchestration/Services/ProviderTurnDeliveryWorker.ts")
      >("./orchestration/Services/ProviderTurnDeliveryWorker.ts");
      const workflowServiceModule = await vi.importActual<
        typeof import("./orchestration/Services/WorkflowService.ts")
      >("./orchestration/Services/WorkflowService.ts");
      const codeReviewWorkflowServiceModule = await vi.importActual<
        typeof import("./orchestration/Services/CodeReviewWorkflowService.ts")
      >("./orchestration/Services/CodeReviewWorkflowService.ts");
      const investigationWorkflowServiceModule = await vi.importActual<
        typeof import("./orchestration/Services/InvestigationWorkflowService.ts")
      >("./orchestration/Services/InvestigationWorkflowService.ts");
      const projectSetupScriptRunnerModule = await vi.importActual<
        typeof import("./project/Services/ProjectSetupScriptRunner.ts")
      >("./project/Services/ProjectSetupScriptRunner.ts");
      const providerSessionDirectoryModule = await vi.importActual<
        typeof import("./provider/Services/ProviderSessionDirectory.ts")
      >("./provider/Services/ProviderSessionDirectory.ts");
      const providerSessionReaperModule = await vi.importActual<
        typeof import("./provider/Services/ProviderSessionReaper.ts")
      >("./provider/Services/ProviderSessionReaper.ts");
      const threadBackgroundWorkModule = await vi.importActual<
        typeof import("./orchestration/Services/ThreadBackgroundWork.ts")
      >("./orchestration/Services/ThreadBackgroundWork.ts");
      const usageServiceModule = await vi.importActual<
        typeof import("./usage/Services/UsageService.ts")
      >("./usage/Services/UsageService.ts");
      const nextTurnQueueDispatcherModule = await vi.importActual<
        typeof import("./nextTurnQueue/Services/NextTurnQueueDispatcher.ts")
      >("./nextTurnQueue/Services/NextTurnQueueDispatcher.ts");
      const storageMaintenanceModule = await vi.importActual<
        typeof import("./storage/StorageMaintenance.ts")
      >("./storage/StorageMaintenance.ts");
      const worktreeManagerModule = await vi.importActual<
        typeof import("./project/Services/WorktreeManager.ts")
      >("./project/Services/WorktreeManager.ts");
      const worktreeSetupModule = await vi.importActual<
        typeof import("./project/Services/WorktreeSetup.ts")
      >("./project/Services/WorktreeSetup.ts");
      const storageCleanupWorkerModule = await vi.importActual<
        typeof import("./storage/StorageCleanupWorker.ts")
      >("./storage/StorageCleanupWorker.ts");
      const skillSyncModule = await vi.importActual<
        typeof import("./orchestration/Services/ProjectSkillSyncService.ts")
      >("./orchestration/Services/ProjectSkillSyncService.ts");
      const defaultBranchAutoPullModule = await vi.importActual<
        typeof import("./git/DefaultBranchAutoPull.ts")
      >("./git/DefaultBranchAutoPull.ts");
      const pendingRuntimeLayer = Layer.mergeAll(
        Layer.succeed(orchestrationEngineModule.OrchestrationEngineService, {
          getReadModel: () => Effect.die(new Error("unused in pending-runtime ws test")),
          readEvents: () => Stream.empty,
          dispatch: () => Effect.die(new Error("unused in pending-runtime ws test")),
          acquireMaintenanceLock: () => Scope.make("sequential"),
          streamDomainEvents: Stream.empty,
        }),
        Layer.succeed(orchestrationReactorModule.OrchestrationReactor, {
          start: Effect.never,
        }),
        Layer.succeed(providerCommandReactorModule.ProviderCommandReactor, {} as any),
        Layer.succeed(providerTurnDeliveryWorkerModule.ProviderTurnDeliveryWorker, {} as any),
        Layer.succeed(providerSessionReaperModule.ProviderSessionReaper, {
          sweep: () => Effect.void,
          start: () => Effect.void,
        }),
        Layer.succeed(threadBackgroundWorkModule.ThreadBackgroundWork, {
          recordProviderEvent: () => Effect.void,
          getSnapshot: Effect.succeed({
            entries: [],
            generatedAt: "2026-01-01T00:00:00.000Z",
          }),
          getThreadSnapshot: () =>
            Effect.succeed({ entries: [], generatedAt: "2026-01-01T00:00:00.000Z" }),
          dismiss: () => Effect.succeed({ dismissedCount: 0 }),
          expireStale: () => Effect.void,
          listProtectedThreadIds: () => Effect.succeed(new Set()),
          hasFreshProtectingWork: () => Effect.succeed(false),
          changes: Stream.empty,
        }),
        Layer.succeed(usageServiceModule.UsageService, {
          consumeResetCredit: () => Effect.die("unused reset credit"),
          refreshAccount: () => Effect.succeed({ snapshot: null, fresh: false }),
          getSummary: () => Effect.die("unused usage summary"),
          getAccounts: () => Effect.succeed([]),
          getQuotaHistory: Effect.die("unused quota history"),
        }),
        Layer.succeed(providerSessionDirectoryModule.ProviderSessionDirectory, {} as any),
        Layer.succeed(skillSyncModule.ProjectSkillSyncService, {
          start: Effect.void,
          drain: Effect.void,
          getWarnings: () => Effect.succeed([]),
        }),
        Layer.succeed(workflowServiceModule.WorkflowService, {} as any),
        Layer.succeed(codeReviewWorkflowServiceModule.CodeReviewWorkflowService, {} as any),
        Layer.succeed(investigationWorkflowServiceModule.InvestigationWorkflowService, {} as any),
        Layer.succeed(projectSetupScriptRunnerModule.ProjectSetupScriptRunner, {} as any),
        Layer.succeed(storageMaintenanceModule.StorageMaintenance, {} as any),
        Layer.succeed(WorktreePreparation, {
          prepare: () => Effect.void,
          needsPreparation: () => Effect.succeed(false),
          startBackground: () => Effect.void,
          startup: Effect.void,
        }),
        Layer.succeed(worktreeManagerModule.WorktreeManager, {} as never),
        Layer.succeed(WorkspaceTransition, {} as never),
        Layer.succeed(worktreeSetupModule.WorktreeSetup, {
          startup: Effect.void,
          changes: Stream.empty,
        } as any),
        Layer.succeed(storageCleanupWorkerModule.StorageCleanupWorker, {
          start: Effect.void,
        } as any),
        Layer.succeed(defaultBranchAutoPullModule.DefaultBranchAutoPull, {
          start: Effect.void,
        } as any),
        Layer.succeed(nextTurnQueueDispatcherModule.NextTurnQueueDispatcher, {
          start: Effect.void,
          notify: () => Effect.void,
          drain: Effect.void,
          getSnapshot: () => Effect.die("unused queue snapshot"),
          getSummary: Effect.succeed({ threads: [] }),
          submitAndSettle: () => Effect.die("unused queue submission"),
          promote: () => Effect.die("unused queue promote"),
          refreshGate: () => Effect.die("unused queue refresh"),
          changes: Stream.empty,
          summaryChanges: Stream.empty,
        } as any),
      );
      return {
        ...actual,
        makeServerOrchestrationRuntimeLayer: () => pendingRuntimeLayer,
      };
    });
    const { createServer: createServerWithPendingRuntime } = await import("./wsServer");

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    h.server = await createTestServer({
      cwd: workspaceRoot,
      stateDir,
      persistenceLayer,
      createServerFactory: createServerWithPendingRuntime,
    });
    addr = h.server.address();
    port = typeof addr === "object" && addr !== null ? addr.port : 0;
    expect(port).toBeGreaterThan(0);

    const [ws] = await connectAndAwaitWelcome(port);
    connections.push(ws);

    const settingsResponse = await Promise.race([
      sendRequest(ws, WS_METHODS.serverGetProjectSettings, {
        projectId: "project-pending-runtime",
      }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("Project settings waited for runtime startup")), 1000),
      ),
    ]);
    expect(settingsResponse.error).toBeUndefined();
    expect(settingsResponse.result).toMatchObject({ skillScanWarnings: [] });

    const threadDetailsResponse = await sendRequest(ws, ORCHESTRATION_WS_METHODS.getThreadDetails, {
      threadId: "thread-pending-runtime",
    });
    expect(threadDetailsResponse.error).toBeUndefined();
    expect(threadDetailsResponse.result).toEqual(
      expect.objectContaining({
        threadId: "thread-pending-runtime",
        messages: [],
        checkpoints: [],
      }),
    );

    // Runtime-dependent methods never park in route slots while the runtime is
    // not ready: twelve of them (more than the ordinary lane's eight slots) all
    // come back at once, as `ServerStarting` while it starts or with the
    // startup failure once this incomplete runtime mock has failed.
    const held = await Promise.all(
      Array.from({ length: 12 }, () =>
        sendRequest(ws, ORCHESTRATION_WS_METHODS.getSnapshot, undefined, {
          retryServerStarting: false,
        }),
      ),
    );
    for (const response of held) {
      expect(response.error).toBeDefined();
      if (response.error?.code !== "ServerStarting")
        expect(response.error?.message).toContain("Orchestration runtime unavailable");
    }
    const probe = await sendRequest(ws, WS_METHODS.serverProbe);
    expect(probe.result).toEqual({
      runtime: expect.objectContaining({ state: expect.stringMatching(/^(starting|failed)$/) }),
    });
    const startup = await sendRequest(ws, ORCHESTRATION_WS_METHODS.getStartupSnapshot, {});
    expect(startup.error).toBeUndefined();

    await new Promise((resolve) => setTimeout(resolve, 50));

    const loggedLines = [...logSpy.mock.calls, ...warnSpy.mock.calls, ...errorSpy.mock.calls]
      .map(([message]) => (typeof message === "string" ? message : ""))
      .filter(Boolean);
    expect(loggedLines.some((line) => line.includes("startup timed out"))).toBe(false);
  });

  it("answers runtime-dependent requests with ServerStarting before claiming a slot", async () => {
    const stateDir = makeTempDir("t3code-state-server-starting-");
    const persistenceLayer = makeSqlitePersistenceLive(path.join(stateDir, "state.sqlite")).pipe(
      Layer.provide(NodeServices.layer),
    );
    vi.resetModules();
    vi.doMock("./serverLayers.ts", async () => ({
      ...(await vi.importActual<typeof import("./serverLayers.ts")>("./serverLayers.ts")),
      // The runtime never finishes building, so readiness stays `starting`.
      makeServerOrchestrationRuntimeLayer: () => Layer.effectDiscard(Effect.never),
    }));
    const { createServer: createServerWithStartingRuntime } = await import("./wsServer");
    h.server = await createTestServer({
      cwd: stateDir,
      stateDir,
      persistenceLayer,
      createServerFactory: createServerWithStartingRuntime,
    });
    const addr = h.server.address();
    const port = typeof addr === "object" && addr !== null ? addr.port : 0;
    const [ws, welcome] = await connectAndAwaitWelcome(port);
    connections.push(ws);
    expect(welcome.data.runtime).toEqual(
      expect.objectContaining({ state: "starting", revision: 0 }),
    );

    // The recovery lane has one slot: answered after admission, eleven of
    // these would come back `RpcBusy` instead.
    const held = await Promise.all(
      Array.from({ length: 12 }, () =>
        sendRequest(ws, ORCHESTRATION_WS_METHODS.getSnapshot, undefined, {
          retryServerStarting: false,
        }),
      ),
    );
    expect(held.map((response) => response.error?.code)).toEqual(Array(12).fill("ServerStarting"));
    // Only the body that takes the route's runtime branch is held.
    const projectInventory = await sendRequest(
      ws,
      WS_METHODS.serverGetProviderInventory,
      { instanceId: "missing", projectId: "project-1" },
      { retryServerStarting: false },
    );
    expect(projectInventory.error?.code).toBe("ServerStarting");
    const globalInventory = await sendRequest(
      ws,
      WS_METHODS.serverGetProviderInventory,
      { instanceId: "missing" },
      { retryServerStarting: false },
    );
    expect(globalInventory.error?.message).toBe("Provider instance not found.");
    const probe = await sendRequest(ws, WS_METHODS.serverProbe);
    expect(probe.result).toEqual({ runtime: expect.objectContaining({ state: "starting" }) });
  });

  it("returns thread tail details without waiting for passive codex reconciliation", async () => {
    const stateDir = makeTempDir("t3code-state-thread-tail-reconcile-");
    const persistenceLayer = makeSqlitePersistenceLive(path.join(stateDir, "state.sqlite")).pipe(
      Layer.provide(NodeServices.layer),
    );
    const workspaceRoot = stateDir;
    const projectId = ProjectId.makeUnsafe("project-tail-reconcile");
    const threadId = asThreadId("thread-tail-reconcile");
    const turnId = asTurnId("turn-tail-reconcile");

    h.server = await createTestServer({
      cwd: workspaceRoot,
      stateDir,
      persistenceLayer,
    });
    let addr = h.server.address();
    let port = typeof addr === "object" && addr !== null ? addr.port : 0;
    expect(port).toBeGreaterThan(0);

    const [seedWs] = await connectAndAwaitWelcome(port);
    connections.push(seedWs);

    const createProjectResponse = await sendRequest(
      seedWs,
      ORCHESTRATION_WS_METHODS.dispatchCommand,
      {
        type: "project.create",
        commandId: "cmd-project-tail-reconcile-create",
        projectId,
        title: "Tail Reconcile Project",
        workspaceRoot,
        defaultModel: "gpt-5-codex",
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    );
    expect(createProjectResponse.error).toBeUndefined();

    const createThreadResponse = await sendRequest(
      seedWs,
      ORCHESTRATION_WS_METHODS.dispatchCommand,
      {
        type: "thread.create",
        commandId: "cmd-thread-tail-reconcile-create",
        threadId,
        projectId,
        title: "Tail Reconcile Thread",
        model: "gpt-5-codex",
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        branch: null,
        worktreePath: null,
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    );
    expect(createThreadResponse.error).toBeUndefined();

    await closeTestServer();
    h.server = null;

    let readThreadStarted = false;

    vi.resetModules();
    vi.doMock("./serverLayers.ts", async () => {
      const actual = await vi.importActual<typeof import("./serverLayers.ts")>("./serverLayers.ts");
      const { McpAppService } = await vi.importActual<typeof import("./mcpApps/McpAppService.ts")>(
        "./mcpApps/McpAppService.ts",
      );
      const { ThreadSettlementService } = await vi.importActual<
        typeof import("./orchestration/Layers/ThreadSettlementService.ts")
      >("./orchestration/Layers/ThreadSettlementService.ts");
      const { PullRequestWatchService } = await vi.importActual<
        typeof import("./orchestration/Layers/PullRequestWatchService.ts")
      >("./orchestration/Layers/PullRequestWatchService.ts");
      const orchestrationEngineModule = await vi.importActual<
        typeof import("./orchestration/Services/OrchestrationEngine.ts")
      >("./orchestration/Services/OrchestrationEngine.ts");
      const orchestrationReactorModule = await vi.importActual<
        typeof import("./orchestration/Services/OrchestrationReactor.ts")
      >("./orchestration/Services/OrchestrationReactor.ts");
      const providerCommandReactorModule = await vi.importActual<
        typeof import("./orchestration/Services/ProviderCommandReactor.ts")
      >("./orchestration/Services/ProviderCommandReactor.ts");
      const providerTurnDeliveryWorkerModule = await vi.importActual<
        typeof import("./orchestration/Services/ProviderTurnDeliveryWorker.ts")
      >("./orchestration/Services/ProviderTurnDeliveryWorker.ts");
      const workflowServiceModule = await vi.importActual<
        typeof import("./orchestration/Services/WorkflowService.ts")
      >("./orchestration/Services/WorkflowService.ts");
      const codeReviewWorkflowServiceModule = await vi.importActual<
        typeof import("./orchestration/Services/CodeReviewWorkflowService.ts")
      >("./orchestration/Services/CodeReviewWorkflowService.ts");
      const investigationWorkflowServiceModule = await vi.importActual<
        typeof import("./orchestration/Services/InvestigationWorkflowService.ts")
      >("./orchestration/Services/InvestigationWorkflowService.ts");
      const projectSetupScriptRunnerModule = await vi.importActual<
        typeof import("./project/Services/ProjectSetupScriptRunner.ts")
      >("./project/Services/ProjectSetupScriptRunner.ts");
      const providerSessionDirectoryModule = await vi.importActual<
        typeof import("./provider/Services/ProviderSessionDirectory.ts")
      >("./provider/Services/ProviderSessionDirectory.ts");
      const providerSessionReaperModule = await vi.importActual<
        typeof import("./provider/Services/ProviderSessionReaper.ts")
      >("./provider/Services/ProviderSessionReaper.ts");
      const threadBackgroundWorkModule = await vi.importActual<
        typeof import("./orchestration/Services/ThreadBackgroundWork.ts")
      >("./orchestration/Services/ThreadBackgroundWork.ts");
      const usageServiceModule = await vi.importActual<
        typeof import("./usage/Services/UsageService.ts")
      >("./usage/Services/UsageService.ts");
      const storageMaintenanceModule = await vi.importActual<
        typeof import("./storage/StorageMaintenance.ts")
      >("./storage/StorageMaintenance.ts");
      const worktreeManagerModule = await vi.importActual<
        typeof import("./project/Services/WorktreeManager.ts")
      >("./project/Services/WorktreeManager.ts");
      const worktreeSetupModule = await vi.importActual<
        typeof import("./project/Services/WorktreeSetup.ts")
      >("./project/Services/WorktreeSetup.ts");
      const storageCleanupWorkerModule = await vi.importActual<
        typeof import("./storage/StorageCleanupWorker.ts")
      >("./storage/StorageCleanupWorker.ts");
      const skillSyncModule = await vi.importActual<
        typeof import("./orchestration/Services/ProjectSkillSyncService.ts")
      >("./orchestration/Services/ProjectSkillSyncService.ts");
      const defaultBranchAutoPullModule = await vi.importActual<
        typeof import("./git/DefaultBranchAutoPull.ts")
      >("./git/DefaultBranchAutoPull.ts");
      const nextTurnQueueDispatcherModule = await vi.importActual<
        typeof import("./nextTurnQueue/Services/NextTurnQueueDispatcher.ts")
      >("./nextTurnQueue/Services/NextTurnQueueDispatcher.ts");

      const readModelThread: OrchestrationThread = {
        id: threadId,
        projectId,
        title: "Tail Reconcile Thread",
        model: "gpt-5-codex",
        runtimeMode: "approval-required",
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        branch: null,
        worktreePath: null,
        latestTurn: {
          turnId,
          state: "completed",
          requestedAt: "2026-01-01T00:00:00.000Z",
          startedAt: "2026-01-01T00:00:00.000Z",
          completedAt: "2026-01-01T00:00:01.000Z",
          assistantMessageId: null,
        },
        archivedAt: null,
        createdAt: "2026-01-01T00:00:00.000Z",
        lastInteractionAt: "2026-01-01T00:00:01.000Z",
        updatedAt: "2026-01-01T00:00:01.000Z",
        deletedAt: null,
        estimatedContextTokens: null,
        modelContextWindowTokens: null,
        messages: [],
        proposedPlans: [],
        tasks: [],
        tasksTurnId: null,
        tasksUpdatedAt: null,
        compaction: null,
        sessionNotes: null,
        threadReferences: [],
        activities: [],
        checkpoints: [],
        session: null,
      };

      const readModel: OrchestrationReadModel = {
        snapshotSequence: 1,
        projects: [],
        threads: [readModelThread],
        planningWorkflows: [],
        codeReviewWorkflows: [],
        investigationWorkflows: [],
        updatedAt: "2026-01-01T00:00:01.000Z",
      };

      const runtimeLayer = Layer.mergeAll(
        Layer.mock(McpAppService)({}),
        Layer.mock(ThreadSettlementService)({ start: Effect.void }),
        Layer.mock(PullRequestWatchService)({ start: Effect.void, changes: Stream.empty }),
        Layer.succeed(orchestrationEngineModule.OrchestrationEngineService, {
          getReadModel: () => Effect.succeed(readModel),
          readEvents: () => Stream.empty,
          dispatch: () => Effect.succeed({ sequence: 1 }),
          acquireMaintenanceLock: () => Scope.make("sequential"),
          streamDomainEvents: Stream.empty,
        }),
        Layer.succeed(orchestrationReactorModule.OrchestrationReactor, {
          start: Effect.void,
        }),
        Layer.succeed(providerCommandReactorModule.ProviderCommandReactor, {} as any),
        Layer.succeed(providerTurnDeliveryWorkerModule.ProviderTurnDeliveryWorker, {} as any),
        Layer.succeed(providerSessionReaperModule.ProviderSessionReaper, {
          sweep: () => Effect.void,
          start: () => Effect.void,
        }),
        Layer.succeed(threadBackgroundWorkModule.ThreadBackgroundWork, {
          recordProviderEvent: () => Effect.void,
          getSnapshot: Effect.succeed({
            entries: [],
            generatedAt: "2026-01-01T00:00:00.000Z",
          }),
          getThreadSnapshot: () =>
            Effect.succeed({ entries: [], generatedAt: "2026-01-01T00:00:00.000Z" }),
          dismiss: () => Effect.succeed({ dismissedCount: 0 }),
          expireStale: () => Effect.void,
          listProtectedThreadIds: () => Effect.succeed(new Set()),
          hasFreshProtectingWork: () => Effect.succeed(false),
          changes: Stream.empty,
        }),
        Layer.succeed(usageServiceModule.UsageService, {
          consumeResetCredit: () => Effect.die("unused reset credit"),
          refreshAccount: () => Effect.succeed({ snapshot: null, fresh: false }),
          getSummary: () => Effect.die("unused usage summary"),
          getAccounts: () => Effect.succeed([]),
          getQuotaHistory: Effect.die("unused quota history"),
        }),
        Layer.succeed(providerSessionDirectoryModule.ProviderSessionDirectory, {
          getBinding: (requestedThreadId: ThreadId) =>
            Effect.succeed(
              requestedThreadId === threadId
                ? Option.some({
                    threadId,
                    projectId,
                    provider: "codex" as const,
                    status: "running" as const,
                    lastSeenAt: "2026-01-01T00:00:00.000Z",
                  })
                : Option.none(),
            ),
        } as any),
        Layer.succeed(skillSyncModule.ProjectSkillSyncService, {
          start: Effect.void,
          drain: Effect.void,
          getWarnings: () => Effect.succeed([]),
        }),
        Layer.succeed(workflowServiceModule.WorkflowService, {} as any),
        Layer.succeed(codeReviewWorkflowServiceModule.CodeReviewWorkflowService, {} as any),
        Layer.succeed(investigationWorkflowServiceModule.InvestigationWorkflowService, {} as any),
        Layer.succeed(projectSetupScriptRunnerModule.ProjectSetupScriptRunner, {} as any),
        Layer.succeed(storageMaintenanceModule.StorageMaintenance, {} as any),
        Layer.succeed(WorktreePreparation, {
          prepare: () => Effect.void,
          needsPreparation: () => Effect.succeed(false),
          startBackground: () => Effect.void,
          startup: Effect.void,
        }),
        Layer.succeed(worktreeManagerModule.WorktreeManager, {} as never),
        Layer.succeed(WorkspaceTransition, {} as never),
        Layer.succeed(worktreeSetupModule.WorktreeSetup, {
          startup: Effect.void,
          changes: Stream.empty,
        } as any),
        Layer.succeed(storageCleanupWorkerModule.StorageCleanupWorker, {
          start: Effect.void,
        } as any),
        Layer.succeed(defaultBranchAutoPullModule.DefaultBranchAutoPull, {
          start: Effect.void,
        } as any),
        Layer.succeed(nextTurnQueueDispatcherModule.NextTurnQueueDispatcher, {
          start: Effect.void,
          notify: () => Effect.void,
          drain: Effect.void,
          getSnapshot: () => Effect.die("unused queue snapshot"),
          getSummary: Effect.succeed({ threads: [] }),
          submitAndSettle: () => Effect.die("unused queue submission"),
          promote: () => Effect.die("unused queue promote"),
          refreshGate: () => Effect.die("unused queue refresh"),
          changes: Stream.empty,
          summaryChanges: Stream.empty,
        } as any),
      );

      return {
        ...actual,
        makeServerOrchestrationRuntimeLayer: () => runtimeLayer,
      };
    });
    const { createServer: createServerWithMockedRuntime } = await import("./wsServer");

    const providerLayer = Layer.succeed(ProviderService, {
      ...defaultProviderService,
      readThread: () =>
        Effect.sync(() => {
          readThreadStarted = true;
        }).pipe(Effect.andThen(Effect.never)),
    } as unknown as ProviderServiceShape);

    h.server = await createTestServer({
      cwd: workspaceRoot,
      stateDir,
      persistenceLayer,
      providerLayer,
      createServerFactory: createServerWithMockedRuntime,
    });
    addr = h.server.address();
    port = typeof addr === "object" && addr !== null ? addr.port : 0;
    expect(port).toBeGreaterThan(0);

    const [ws] = await connectAndAwaitWelcome(port);
    connections.push(ws);

    const tailResponse = await Promise.race([
      sendRequest(ws, ORCHESTRATION_WS_METHODS.getThreadTailDetails, {
        threadId,
      }),
      new Promise<never>((_, reject) => {
        setTimeout(() => {
          reject(new Error("Timed out waiting for thread tail details"));
        }, 1_000);
      }),
    ]);

    expect(tailResponse.error).toBeUndefined();
    expect(tailResponse.result).toEqual(
      expect.objectContaining({
        threadId,
        messages: [],
        checkpoints: [],
        hasOlderMessages: false,
        hasOlderCheckpoints: false,
      }),
    );

    await vi.waitFor(() => expect(readThreadStarted).toBe(true), { timeout: 1_000 });
  });

  it("logs outbound websocket push events in dev mode", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {
      // Keep test output clean while verifying websocket logs.
    });

    h.server = await createTestServer({
      cwd: "/test/project",
      devUrl: "http://localhost:5173",
    });
    const addr = h.server.address();
    const port = typeof addr === "object" && addr !== null ? addr.port : 0;
    expect(port).toBeGreaterThan(0);

    const [ws] = await connectAndAwaitWelcome(port);
    connections.push(ws);

    expect(
      logSpy.mock.calls.some(([message]) => {
        if (typeof message !== "string") return false;
        return (
          message.includes("[ws]") &&
          message.includes("outgoing push") &&
          message.includes(`channel="${WS_CHANNELS.serverWelcome}"`)
        );
      }),
    ).toBe(true);
  });

  it("responds to server.probe without waiting for provider or orchestration work", async () => {
    h.server = await createTestServer();

    const address = h.server.address();
    if (!address || typeof address === "string") throw new Error("No server address");
    const [ws] = await connectAndAwaitWelcome(address.port);
    connections.push(ws);

    const response = await sendRequest(ws, WS_METHODS.serverProbe);
    expect(response.error).toBeUndefined();
    // The probe also reports runtime readiness, the client's fallback while it starts.
    expect(response.result).toEqual({
      runtime: expect.objectContaining({ state: expect.stringMatching(/^(starting|ready)$/) }),
    });
  });

  it("reports runtime readiness in the welcome and the probe once the runtime is ready", async () => {
    h.server = await createTestServer();
    const address = h.server.address();
    if (!address || typeof address === "string") throw new Error("No server address");
    const [ws, welcome] = await connectAndAwaitWelcome(address.port);
    connections.push(ws);
    expect(welcome.data.runtime?.state).toMatch(/^(starting|ready)$/);

    await vi.waitFor(
      async () => {
        const response = await sendRequest(ws, WS_METHODS.serverProbe);
        expect(response.result).toEqual({ runtime: { state: "ready", revision: 1 } });
      },
      { timeout: 10_000, interval: 100 },
    );
  });

  it("rejects runtime-dependent methods before admission while the runtime starts", () => {
    const starting = { state: "starting", revision: 0 } as const;
    const getSnapshot = { _tag: ORCHESTRATION_WS_METHODS.getSnapshot };
    expect(serverStartingRejection(getSnapshot, starting)).toMatchObject({
      code: "ServerStarting",
      retryable: true,
      retryAfterMs: 1_000,
    });
    // Projection-backed and health methods still answer during startup.
    expect(
      serverStartingRejection({ _tag: ORCHESTRATION_WS_METHODS.getStartupSnapshot }, starting),
    ).toBe(null);
    expect(serverStartingRejection({ _tag: WS_METHODS.serverProbe }, starting)).toBe(null);
    // A route that awaits the runtime only on one branch is rejected for that body only.
    expect(serverStartingRejection({ _tag: WS_METHODS.serverGetProviderInventory }, starting)).toBe(
      null,
    );
    expect(
      serverStartingRejection(
        { _tag: WS_METHODS.serverGetProviderInventory, projectId: "project-1" } as {
          _tag: string;
        },
        starting,
      ),
    ).toMatchObject({ code: "ServerStarting" });
    expect(serverStartingRejection(getSnapshot, { state: "ready", revision: 1 })).toBe(null);
    // A failed startup lets the route report the failure itself.
    expect(
      serverStartingRejection(getSnapshot, { state: "failed", revision: 1, message: "boom" }),
    ).toBe(null);
  });

  it("encodes a response-encoding failure without the failing schema", () => {
    expect(JSON.parse(encodeResponseEncodeFailure("req-1"))).toEqual({
      id: "req-1",
      error: { message: "Response could not be encoded", code: "ResponseEncodeFailed" },
    });
  });

  it("returns error for unknown methods", async () => {
    h.server = await createTestServer({ cwd: "/test" });
    const addr = h.server.address();
    const port = typeof addr === "object" && addr !== null ? addr.port : 0;

    const [ws] = await connectAndAwaitWelcome(port);
    connections.push(ws);

    const response = await sendRequest(ws, "nonexistent.method");
    expect(response.error).toBeDefined();
    expect(response.error!.message).toContain("Invalid request format");
    // The caller's id is echoed so clients reject immediately instead of timing out.
    expect(response.id).not.toBe("unknown");
  });

  it("recovers request ids from undecodable requests", () => {
    expect(readWebSocketRequestId(JSON.stringify({ id: "abc", body: { _tag: "x" } }))).toBe("abc");
    expect(readWebSocketRequestId(JSON.stringify({ id: 7 }))).toBeNull();
    expect(readWebSocketRequestId(JSON.stringify({ id: "x".repeat(200) }))).toBeNull();
    expect(readWebSocketRequestId("not json")).toBeNull();
    expect(readWebSocketRequestId("null")).toBeNull();
  });

  it("handles invalid JSON gracefully", async () => {
    h.server = await createTestServer({ cwd: "/test" });
    const addr = h.server.address();
    const port = typeof addr === "object" && addr !== null ? addr.port : 0;

    const [ws] = await connectAndAwaitWelcome(port);
    connections.push(ws);

    // Send garbage
    ws.send("not json at all");

    // Error response goes to the response channel
    const channels = channelsBySocket.get(ws)!;
    let response: WebSocketResponse | null = null;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const message = await dequeue(channels.response, 5_000);
      if (message.id === "unknown") {
        response = message;
        break;
      }
      if (message.error) {
        response = message;
        break;
      }
    }
    expect(response).toBeDefined();
    expect(response!.error).toBeDefined();
    expect(response!.error!.message).toContain("Invalid request format");
  });

  for (const constructionThrow of [false, true]) {
    it(`isolates route defects from concurrent and later requests, construction throw=${constructionThrow}`, async () => {
      const started = Effect.runSync(Deferred.make<void>());
      const released = Effect.runSync(Deferred.make<void>());
      const open: OpenShape = {
        ...defaultOpenService,
        openInEditor: ({ cwd }) => {
          if (cwd === "/fixture/pending") {
            return Deferred.succeed(started, undefined).pipe(
              Effect.andThen(Deferred.await(released)),
            );
          }
          if (cwd === "/fixture/failing") {
            if (constructionThrow) throw new Error("fixture route construction defect");
            return Effect.die(new Error("fixture route defect"));
          }
          return Effect.void;
        },
      };
      h.server = await createTestServer({ cwd: "/test", open });
      const address = h.server.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      const [ws] = await connectAndAwaitWelcome(port);
      connections.push(ws);
      const responses = channelsBySocket.get(ws)!.response;
      const send = (id: string, cwd: string) =>
        ws.send(
          JSON.stringify({
            id,
            body: { _tag: WS_METHODS.shellOpenInEditor, cwd, editor: "cursor" },
          }),
        );
      try {
        send("pending", "/fixture/pending");
        await Effect.runPromise(Deferred.await(started).pipe(Effect.timeout("5 seconds")));
        send("failing", "/fixture/failing");
        const failed = await dequeue(responses, 5_000);
        expect(failed.id).toBe("failing");
        expect(failed.error).toBeDefined();
        send("later", "/fixture/success");
        const later = await dequeue(responses, 5_000);
        expect(later.id).toBe("later");
        expect(later.error).toBeUndefined();
        expect(ws.readyState).toBe(WebSocket.OPEN);
      } finally {
        Effect.runSync(Deferred.succeed(released, undefined));
      }
      const pending = await dequeue(responses, 5_000);
      expect(pending.id).toBe("pending");
      expect(pending.error).toBeUndefined();
    });
  }

  it("catches websocket message handler rejections and keeps the socket usable", async () => {
    const unhandledRejections: unknown[] = [];
    const onUnhandledRejection = (reason: unknown) => {
      unhandledRejections.push(reason);
    };
    process.on("unhandledRejection", onUnhandledRejection);

    const brokenOpenService: OpenShape = {
      openBrowser: () => Effect.void,
      openInEditor: () =>
        Effect.sync(() => BigInt(1)).pipe(Effect.map((result) => result as unknown as void)),
      revealInFileManager: () => Effect.void,
    };

    try {
      h.server = await createTestServer({ cwd: "/test", open: brokenOpenService });
      const addr = h.server.address();
      const port = typeof addr === "object" && addr !== null ? addr.port : 0;

      const [ws] = await connectAndAwaitWelcome(port);
      connections.push(ws);

      ws.send(
        JSON.stringify({
          id: "req-broken-open",
          body: {
            _tag: WS_METHODS.shellOpenInEditor,
            cwd: "/tmp",
            editor: "cursor",
          },
        }),
      );

      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(unhandledRejections).toHaveLength(0);

      const workspace = makeTempDir("t3code-ws-handler-still-usable-");
      fs.writeFileSync(path.join(workspace, "file.txt"), "ok\n", "utf8");
      const response = await sendRequest(ws, WS_METHODS.projectsSearchEntries, {
        cwd: workspace,
        query: "file",
        limit: 5,
      });
      expect(response.error).toBeUndefined();
      expect(response.result).toEqual(
        expect.objectContaining({
          entries: expect.arrayContaining([
            expect.objectContaining({
              path: "file.txt",
              kind: "file",
            }),
          ]),
        }),
      );
    } finally {
      process.off("unhandledRejection", onUnhandledRejection);
    }
  });

  it.each([null, "0", "25", "26", "999", "1&protocol=1"])(
    "rejects incompatible protocol %s without sending any domain data",
    async (protocol) => {
      h.server = await createTestServer({ cwd: "/test", authToken: "secret-token" });
      const address = h.server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      const result = await new Promise<{ code: number; reason: string; messages: string[] }>(
        (resolve, reject) => {
          const socket = new WebSocket(
            `ws://127.0.0.1:${port}/?token=secret-token${protocol === null ? "" : `&protocol=${protocol}`}`,
          );
          const messages: string[] = [];
          socket.on("error", reject);
          socket.on("message", (raw) => messages.push(String(raw)));
          socket.on("open", () =>
            socket.send(
              JSON.stringify({ id: "stale", body: { _tag: ORCHESTRATION_WS_METHODS.getSnapshot } }),
            ),
          );
          socket.on("close", (code, reason) => resolve({ code, reason: String(reason), messages }));
        },
      );
      expect(result).toEqual({
        code: F5_UPGRADE_REQUIRED_CLOSE_CODE,
        reason: JSON.stringify({ error: "upgrade-required", protocolVersion: F5_PROTOCOL_VERSION }),
        messages: [],
      });
      const [current, welcome] = await connectAndAwaitWelcome(port, "secret-token");
      connections.push(current);
      expect(welcome.data.bootstrap).toEqual(SERVER_BOOTSTRAP);
    },
  );

  it("authenticates bootstrap metadata and rejects stale upload protocols before consuming bytes", async () => {
    h.server = await createTestServer({ cwd: "/test", authToken: "secret-token" });
    const address = h.server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    const base = `http://127.0.0.1:${port}`;
    expect((await fetch(`${base}/api/bootstrap`)).status).toBe(401);
    const metadata = await fetch(`${base}/api/bootstrap`, {
      headers: { Authorization: "Bearer secret-token" },
    });
    expect(metadata.headers.get("cache-control")).toBe("no-store");
    expect(await metadata.json()).toEqual(SERVER_BOOTSTRAP);
    for (const version of [undefined, "0", "999"]) {
      const response = await fetch(`${base}/api/storage/restore`, {
        method: "POST",
        headers: {
          Authorization: "Bearer secret-token",
          ...(version ? { [F5_PROTOCOL_HEADER]: version } : {}),
        },
        body: "not a backup",
      });
      expect(response.status).toBe(426);
      expect(await response.json()).toEqual({
        error: "upgrade-required",
        protocolVersion: F5_PROTOCOL_VERSION,
      });
    }
    const current = await fetch(`${base}/api/storage/restore`, {
      method: "POST",
      headers: {
        Authorization: "Bearer secret-token",
        [F5_PROTOCOL_HEADER]: String(F5_PROTOCOL_VERSION),
      },
      body: "not a backup",
    });
    expect(current.status).toBe(400);
  });

  it("serves capability assets with the real request origin in CSP and renderer CORS", async () => {
    const stateDir = makeTempDir("f5-asset-origin-");
    const attachments = path.join(stateDir, "attachments");
    fs.mkdirSync(attachments, { recursive: true });
    fs.writeFileSync(
      path.join(attachments, "page.html"),
      '<link rel="stylesheet" href="page.css">',
    );
    fs.writeFileSync(path.join(attachments, "page.css"), "body { color: red }");
    fs.writeFileSync(path.join(attachments, "notes.md"), "# Notes");
    h.server = await createTestServer({
      mode: "desktop",
      cwd: "/test",
      stateDir,
      authToken: "secret-token",
    });
    const address = h.server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    const base = `http://127.0.0.1:${port}`;
    const [ws] = await connectAndAwaitWelcome(port, "secret-token", { Origin: "t3://app" });
    connections.push(ws);
    const response = await sendRequest(ws, WS_METHODS.projectsIssueAssetUrl, {
      identity: { kind: "attachments" },
      files: [
        { relativePath: "page.html", grant: "html-document" },
        { relativePath: "missing.png", grant: "file" },
        { relativePath: "notes.md", grant: "file" },
      ],
    });
    expect(response.error).toBeUndefined();
    // An unreadable entry is reported alone instead of failing the whole batch.
    const [html, missing, notes] = response.result as Array<{ url: string } | null>;
    expect(missing).toBeNull();

    const document = await fetch(`${base}${html!.url}`);
    await document.text();
    const handlePrefix = `${base}${html!.url.slice(0, html!.url.lastIndexOf("/") + 1)}`;
    const csp = document.headers.get("content-security-policy") ?? "";
    expect(csp).toContain(`style-src ${handlePrefix};`);
    expect(csp).not.toContain("localhost");
    // The sibling the CSP allows is actually served under that prefix.
    const stylesheet = await fetch(`${handlePrefix}page.css`);
    expect(stylesheet.status).toBe(200);
    expect(await stylesheet.text()).toBe("body { color: red }");

    // The renderer reads text previews with fetch(), which needs CORS but no credentials.
    const text = await fetch(`${base}${notes!.url}`, { headers: { Origin: "t3://app" } });
    expect(text.status).toBe(200);
    expect(text.headers.get("access-control-allow-origin")).toBe("t3://app");
    expect(text.headers.get("access-control-allow-credentials")).toBeNull();
    expect(await text.text()).toBe("# Notes");
    const foreign = await fetch(`${base}${notes!.url}`, {
      headers: { Origin: "https://attacker.example" },
    });
    await foreign.text();
    expect(foreign.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("opens an extensionless persisted attachment through a restricted capability URL", async () => {
    const stateDir = makeTempDir("f5-attachment-viewer-");
    fs.mkdirSync(path.join(stateDir, "attachments"), { recursive: true });
    fs.writeFileSync(path.join(stateDir, "attachments", "saved-document.pdf"), "%PDF-test");
    h.server = await createTestServer({ cwd: "/test", stateDir, authToken: "secret-token" });
    const address = h.server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    const [ws] = await connectAndAwaitWelcome(port, "secret-token");
    connections.push(ws);
    const response = await sendRequest(ws, WS_METHODS.projectsIssueAssetUrl, {
      identity: { kind: "attachments" },
      files: [{ relativePath: "saved-document", grant: "file" }],
    });
    expect(response.error).toBeUndefined();
    const grants = response.result as Array<{ url: string }>;
    expect(grants).toHaveLength(1);
    const url = `http://127.0.0.1:${port}${grants[0]!.url}`;
    const document = await fetch(url);
    expect(document.status).toBe(200);
    expect(document.headers.get("content-type")).toBe("application/pdf");
    expect(await document.text()).toBe("%PDF-test");
    expect((await fetch(url, { method: "POST" })).status).toBe(405);
    expect((await fetch(url.replace("saved-document.pdf", "other.pdf"))).status).toBe(400);
  });

  it("streams generic uploads with protocol, origin, filename, and range checks", async () => {
    h.server = await createTestServer({ cwd: "/test", authToken: "secret-token" });
    const address = h.server.address();
    const base = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
    const url = `${base}/api/attachments/uploads?threadId=draft-files`;
    const auth = { Authorization: "Bearer secret-token" };
    expect((await fetch(url, { method: "POST", headers: auth, body: "file" })).status).toBe(426);
    const headers = {
      ...auth,
      [F5_PROTOCOL_HEADER]: String(F5_PROTOCOL_VERSION),
      "X-F5-File-Name": encodeURIComponent("世界.pdf"),
      "Content-Type": "application/pdf",
    };
    expect(
      (
        await fetch(url, {
          method: "POST",
          headers: { ...headers, Origin: "https://untrusted.example" },
          body: "file",
        })
      ).status,
    ).toBe(403);
    const response = await fetch(url, { method: "POST", headers, body: "%PDF-test" });
    expect(response.status).toBe(201);
    const upload = (await response.json()) as { uploadId: string; name: string; kind: string };
    expect(upload).toMatchObject({ name: "世界.pdf", kind: "file" });
    const fileUrl = `${base}/api/attachments/uploads/${upload.uploadId}`;
    expect((await fetch(fileUrl)).status).toBe(401);
    const range = await fetch(fileUrl, { headers: { ...auth, Range: "bytes=0-3" } });
    expect(range.status).toBe(206);
    expect(range.headers.get("content-range")).toBe("bytes 0-3/9");
    expect(range.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await range.text()).toBe("%PDF");
    expect((await fetch(fileUrl, { headers: { ...auth, Range: "bytes=99-" } })).status).toBe(416);
  });

  it("releases a draft's upload staging once the queued turn owns its copy", async () => {
    const stateDir = makeTempDir("f5-upload-release-");
    h.server = await createTestServer({ cwd: "/test", stateDir, authToken: "secret-token" });
    const address = h.server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    const base = `http://127.0.0.1:${port}`;
    const [ws] = await connectAndAwaitWelcome(port, "secret-token");
    connections.push(ws);
    const createdAt = new Date().toISOString();
    expect(
      (
        await sendRequest(ws, ORCHESTRATION_WS_METHODS.dispatchCommand, {
          type: "project.create",
          commandId: "cmd-upload-release-project",
          projectId: "project-upload-release",
          title: "Uploads",
          workspaceRoot: makeTempDir("f5-upload-release-project-"),
          defaultModel: "gpt-5-codex",
          createdAt,
        })
      ).error,
    ).toBeUndefined();
    expect(
      (
        await sendRequest(ws, ORCHESTRATION_WS_METHODS.dispatchCommand, {
          type: "thread.create",
          commandId: "cmd-upload-release-thread",
          threadId: "thread-upload-release",
          projectId: "project-upload-release",
          title: "Uploads",
          model: "gpt-5-codex",
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdAt,
        })
      ).error,
    ).toBeUndefined();

    const uploaded = await fetch(`${base}/api/attachments/uploads?threadId=thread-upload-release`, {
      method: "POST",
      headers: {
        Authorization: "Bearer secret-token",
        [F5_PROTOCOL_HEADER]: String(F5_PROTOCOL_VERSION),
        "X-F5-File-Name": "notes.txt",
        "Content-Type": "text/plain",
      },
      body: "sent once",
    });
    expect(uploaded.status).toBe(201);
    const { uploadId } = (await uploaded.json()) as { uploadId: string };
    const uploadsDir = path.join(stateDir, "attachments", ".uploads");
    const stagedBefore = fs.readdirSync(uploadsDir);
    expect(stagedBefore.length).toBeGreaterThan(0);

    const submitted = await sendRequest(ws, WS_METHODS.nextTurnQueueSubmit, {
      submissionId: "submission-upload-release",
      intent: "queue-tail",
      command: {
        type: "thread.turn.start",
        commandId: "cmd-upload-release-turn",
        threadId: "thread-upload-release",
        message: {
          messageId: "msg-upload-release",
          role: "user",
          text: "see attached",
          attachments: [{ type: "upload", uploadId }],
        },
        assistantDeliveryMode: "streaming",
        runtimeMode: "approval-required",
        interactionMode: "default",
        createdAt,
      },
    });
    expect(submitted.error).toBeUndefined();

    // The upload row and its staged bytes are gone; the queued copy is unaffected.
    const renewed = await sendRequest(ws, WS_METHODS.attachmentsGetUploads, {
      threadId: "thread-upload-release",
      uploadIds: [uploadId],
    });
    expect(renewed.result).toEqual([null]);
    expect(fs.readdirSync(uploadsDir)).toEqual([]);
  });

  it("rejects websocket connections without a valid auth token", async () => {
    h.server = await createTestServer({ cwd: "/test", authToken: "secret-token" });
    const addr = h.server.address();
    const port = typeof addr === "object" && addr !== null ? addr.port : 0;

    await expect(connectWs(port)).rejects.toThrow("WebSocket connection failed");

    const [authorizedWs] = await connectAndAwaitWelcome(port, "secret-token");
    connections.push(authorizedWs);
  });

  it("accepts the authenticated packaged desktop websocket origin", async () => {
    h.server = await createTestServer({
      mode: "desktop",
      cwd: "/test",
      authToken: "secret-token",
    });
    const addr = h.server.address();
    const port = typeof addr === "object" && addr !== null ? addr.port : 0;

    const [authorizedWs] = await connectAndAwaitWelcome(port, "secret-token", {
      Origin: "t3://app",
    });
    connections.push(authorizedWs);
  });

  it("allows narrowly scoped desktop renderer CORS requests to private HTTP routes", async () => {
    const stateDir = makeTempDir("t3code-state-desktop-cors-");
    h.server = await createTestServer({
      mode: "desktop",
      cwd: "/test",
      authToken: "secret-token",
      stateDir,
      persistenceLayer: makeSqlitePersistenceLive(path.join(stateDir, "state.sqlite")).pipe(
        Layer.provide(NodeServices.layer),
      ),
    });
    const addr = h.server.address();
    const port = typeof addr === "object" && addr !== null ? addr.port : 0;
    const origin = `http://127.0.0.1:${port}`;

    const preflightResponse = await fetch(`${origin}/api/storage/restore`, {
      method: "OPTIONS",
      headers: {
        Origin: "t3://app",
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "authorization, content-type, x-f5-backup-password",
      },
    });
    expect(preflightResponse.status).toBe(204);
    expect(preflightResponse.headers.get("access-control-allow-origin")).toBe("t3://app");
    expect(preflightResponse.headers.get("access-control-allow-credentials")).toBe("true");
    expect(preflightResponse.headers.get("access-control-allow-methods")).toBe("GET, POST");
    expect(preflightResponse.headers.get("access-control-allow-headers")).toBe(
      "Authorization, Content-Type, X-F5-Backup-Password, X-F5-Protocol, X-F5-File-Name, X-F5-Upload-Client",
    );

    // The exact headers `uploadAttachment` sends must survive the preflight.
    const uploadPreflight = await fetch(`${origin}/api/attachments/uploads?threadId=draft-cors`, {
      method: "OPTIONS",
      headers: {
        Origin: "t3://app",
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers":
          "authorization, content-type, x-f5-file-name, x-f5-protocol, x-f5-upload-client",
      },
    });
    expect(uploadPreflight.status).toBe(204);
    expect(uploadPreflight.headers.get("access-control-allow-origin")).toBe("t3://app");

    const unauthenticatedResponse = await fetch(`${origin}/api/storage/backup`, {
      headers: { Origin: "t3://app" },
    });
    expect(unauthenticatedResponse.status).toBe(401);
    expect(unauthenticatedResponse.headers.get("access-control-allow-origin")).toBe("t3://app");

    const backupResponse = await fetch(`${origin}/api/storage/backup`, {
      headers: {
        Authorization: "Bearer secret-token",
        Origin: "t3://app",
      },
    });
    await backupResponse.arrayBuffer();
    expect(backupResponse.status).toBe(200);
    expect(backupResponse.headers.get("access-control-allow-origin")).toBe("t3://app");
    expect(backupResponse.headers.get("access-control-expose-headers")).toBe(
      "Content-Disposition, Content-Length",
    );
  });

  it("rejects desktop private-route preflights outside the exact CORS allowlist", async () => {
    h.server = await createTestServer({
      mode: "desktop",
      cwd: "/test",
      authToken: "secret-token",
    });
    const addr = h.server.address();
    const port = typeof addr === "object" && addr !== null ? addr.port : 0;
    const url = `http://127.0.0.1:${port}/api/storage/restore`;

    const disallowedOriginResponse = await fetch(url, {
      method: "OPTIONS",
      headers: {
        Origin: "https://attacker.example",
        "Access-Control-Request-Method": "POST",
      },
    });
    expect(disallowedOriginResponse.status).toBe(403);
    expect(disallowedOriginResponse.headers.get("access-control-allow-origin")).toBeNull();

    const disallowedHeaderResponse = await fetch(url, {
      method: "OPTIONS",
      headers: {
        Origin: "t3://app",
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "authorization, x-not-allowed",
      },
    });
    expect(disallowedHeaderResponse.status).toBe(403);
  });

  it("accepts the authenticated configured development origin", async () => {
    h.server = await createTestServer({
      cwd: "/test",
      authToken: "secret-token",
      devUrl: "http://localhost:5173",
    });
    const addr = h.server.address();
    const port = typeof addr === "object" && addr !== null ? addr.port : 0;

    const [authorizedWs] = await connectAndAwaitWelcome(port, "secret-token", {
      Origin: "http://localhost:5173",
    });
    connections.push(authorizedWs);
  });

  it("allows configured development origins to fetch private attachments", async () => {
    const stateDir = makeTempDir("t3code-state-development-cors-");
    const attachmentPath = path.join(stateDir, "attachments", "thread-image.png");
    fs.mkdirSync(path.dirname(attachmentPath), { recursive: true });
    fs.writeFileSync(attachmentPath, Buffer.from("image-bytes"));
    h.server = await createTestServer({
      cwd: "/test",
      authToken: "secret-token",
      devUrl: "http://localhost:5173",
      stateDir,
    });
    const addr = h.server.address();
    const port = typeof addr === "object" && addr !== null ? addr.port : 0;
    const url = `http://127.0.0.1:${port}/attachments/thread-image.png`;

    const imageElementResponse = await fetch(url, {
      headers: { Authorization: "Bearer secret-token" },
    });
    expect(imageElementResponse.status).toBe(200);
    expect(imageElementResponse.headers.get("access-control-allow-origin")).toBeNull();
    expect(imageElementResponse.headers.get("vary")).toBe("Origin");

    const preflightResponse = await fetch(url, {
      method: "OPTIONS",
      headers: {
        Origin: "http://localhost:5173",
        "Access-Control-Request-Method": "GET",
        "Access-Control-Request-Headers": "authorization",
      },
    });
    expect(preflightResponse.status).toBe(204);
    expect(preflightResponse.headers.get("access-control-allow-origin")).toBe(
      "http://localhost:5173",
    );

    const attachmentResponse = await fetch(url, {
      headers: {
        Authorization: "Bearer secret-token",
        Origin: "http://localhost:5173",
      },
    });
    expect(attachmentResponse.status).toBe(200);
    expect(attachmentResponse.headers.get("access-control-allow-origin")).toBe(
      "http://localhost:5173",
    );
    expect(Buffer.from(await attachmentResponse.arrayBuffer())).toEqual(Buffer.from("image-bytes"));
  });

  it("rejects foreign private-route CORS access in web mode", async () => {
    const stateDir = makeTempDir("t3code-state-web-cors-rejection-");
    const attachmentPath = path.join(stateDir, "attachments", "thread-image.png");
    fs.mkdirSync(path.dirname(attachmentPath), { recursive: true });
    fs.writeFileSync(attachmentPath, Buffer.from("image-bytes"));
    h.server = await createTestServer({
      mode: "web",
      cwd: "/test",
      authToken: "secret-token",
      stateDir,
    });
    const addr = h.server.address();
    const port = typeof addr === "object" && addr !== null ? addr.port : 0;
    const url = `http://127.0.0.1:${port}/attachments/thread-image.png`;

    const preflightResponse = await fetch(url, {
      method: "OPTIONS",
      headers: {
        Origin: "https://attacker.example",
        "Access-Control-Request-Method": "GET",
        "Access-Control-Request-Headers": "authorization",
      },
    });
    expect(preflightResponse.status).toBe(403);
    expect(preflightResponse.headers.get("access-control-allow-origin")).toBeNull();

    const attachmentResponse = await fetch(url, {
      headers: {
        Authorization: "Bearer secret-token",
        Origin: "https://attacker.example",
      },
    });
    expect(attachmentResponse.status).toBe(200);
    expect(attachmentResponse.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("prepares a complete backup before committing the download response", async () => {
    const stateDir = makeTempDir("t3code-state-backup-export-");
    h.server = await createTestServer({
      cwd: "/test",
      stateDir,
      persistenceLayer: makeSqlitePersistenceLive(path.join(stateDir, "state.sqlite")).pipe(
        Layer.provide(NodeServices.layer),
      ),
    });
    const addr = h.server.address();
    const port = typeof addr === "object" && addr !== null ? addr.port : 0;

    const response = await fetch(`http://127.0.0.1:${port}/api/storage/backup`);
    const archive = await response.arrayBuffer();

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/x-f5-backup");
    expect(Number(response.headers.get("content-length"))).toBe(archive.byteLength);
    expect(archive.byteLength).toBeGreaterThan(0);
  });

  it("returns an HTTP error when backup preparation fails before streaming", async () => {
    const stateDir = makeTempDir("t3code-state-backup-failure-");
    fs.writeFileSync(path.join(stateDir, "backup-staging"), "blocks staging directory creation");
    h.server = await createTestServer({ cwd: "/test", stateDir });
    const addr = h.server.address();
    const port = typeof addr === "object" && addr !== null ? addr.port : 0;

    const response = await fetch(`http://127.0.0.1:${port}/api/storage/backup`);

    expect(response.status).toBe(500);
    expect(response.headers.get("content-type")).toContain("application/json");
    const body = (await response.json()) as { error?: unknown };
    expect(typeof body.error).toBe("string");
    expect((body.error as string).length).toBeGreaterThan(0);
  });

  it("exchanges remote auth tokens and protects private routes with long thread IDs", async () => {
    const stateDir = makeTempDir("t3code-state-auth-");
    const longThreadId = `thread-${"a".repeat(160)}`;
    const attachmentPath = path.join(stateDir, "attachments", longThreadId, "message-a", "0.txt");
    fs.mkdirSync(path.dirname(attachmentPath), { recursive: true });
    fs.writeFileSync(attachmentPath, "private attachment");

    h.server = await createTestServer({
      cwd: "/test",
      authToken: "secret-token",
      stateDir,
    });
    const addr = h.server.address();
    const port = typeof addr === "object" && addr !== null ? addr.port : 0;
    const origin = `http://127.0.0.1:${port}`;
    const attachmentUrl = `${origin}/attachments/${longThreadId}/message-a/0.txt`;

    const unauthenticatedResponse = await fetch(attachmentUrl);
    expect(unauthenticatedResponse.status).toBe(401);

    const invalidSessionResponse = await fetch(`${origin}/auth/session`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: "wrong-token" }),
    });
    expect(invalidSessionResponse.status).toBe(401);

    const sessionResponse = await fetch(`${origin}/auth/session`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: "secret-token" }),
    });
    expect(sessionResponse.status).toBe(204);
    const setCookie = sessionResponse.headers.get("set-cookie");
    expect(setCookie).toMatch(/f5_session(?:_[0-9a-f]{32})?=/);
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=Strict");
    const cookie = setCookie?.split(";", 1)[0];
    expect(cookie).toBeTruthy();

    const authenticatedResponse = await fetch(attachmentUrl, {
      headers: { Cookie: cookie ?? "" },
    });
    expect(authenticatedResponse.status).toBe(200);
    expect(await authenticatedResponse.text()).toBe("private attachment");

    const [authorizedWs] = await connectAndAwaitWelcome(port, undefined, {
      Cookie: cookie ?? "",
      Origin: origin,
    });
    connections.push(authorizedWs);

    await expect(
      connectWs(port, "secret-token", 1, { Origin: "https://attacker.example" }),
    ).rejects.toThrow("WebSocket connection failed");

    const logoutResponse = await fetch(`${origin}/auth/logout`, {
      method: "POST",
      headers: { Cookie: cookie ?? "" },
    });
    expect(logoutResponse.status).toBe(204);
    expect((await fetch(attachmentUrl, { headers: { Cookie: cookie ?? "" } })).status).toBe(401);
  });
});
