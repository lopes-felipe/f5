import { createServer } from "node:http";
import { once } from "node:events";
import { spawn, fork } from "node:child_process";
import {
  createReadStream,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { Effect, Exit, Layer, ManagedRuntime, Ref, Scope } from "effect";
import * as NodeServices from "@effect/platform-node/NodeServices";
import WebSocket, { WebSocketServer } from "ws";
import { expect, it } from "vitest";
import type { OrchestrationEvent } from "@t3tools/contracts";
import { TerminalManagerRuntime } from "../../src/terminal/Layers/Manager.ts";
import { NodePtyAdapterLive } from "../../src/terminal/Layers/NodePTY.ts";
import { PtyAdapter } from "../../src/terminal/Services/PTY.ts";
import { makeServerPushBus, makeWebSocketSendController } from "../../src/wsServer/pushBus.ts";
import { resolveServerPerMessageDeflate } from "../../src/wsServer/webSocketTransport.ts";
import { fixture } from "../../../../scripts/lib/performance/fixtures.ts";
import {
  createBrowserFixture,
  IMAGE_BYTES,
} from "../../../../scripts/lib/performance/browserFixture.ts";
import {
  metadata,
  maximumObservation,
  measure,
  percentile95,
  retainedMemoryObservations,
  type Samples,
} from "../../../../scripts/lib/performance/report.ts";

const root = fileURLToPath(new URL("../../../..", import.meta.url));
type MemorySample = {
  elapsedMs: number;
  heapBytes: number;
  server: { heapBytes: number; rssBytes: number; terminalHistoryBytes: number };
};

it("measures the production renderer, real WS backpressure and native terminal soak", async () => {
  const output = process.env.F5_PERF_REPORT;
  if (!output) throw new Error("F5_PERF_REPORT required");
  const smoke = process.env.F5_PERF_SMOKE === "1";
  const minutes = Number(
    process.env.F5_PERF_MEMORY_MINUTES ?? (smoke ? 0 : fixture.method.retainedMemoryMinutes),
  );
  if (
    (!smoke && minutes !== fixture.method.retainedMemoryMinutes) ||
    !Number.isInteger(minutes) ||
    minutes < 0 ||
    minutes > fixture.method.retainedMemoryMinutes
  )
    throw new Error("Full measurements require a 10-minute soak; smoke permits 0..10 minutes");
  if (!existsSync(path.join(root, "apps/web/dist/index.html")))
    throw new Error("Build apps/web first");
  const method = smoke ? { ...fixture.method, warmups: 1, repetitions: 2 } : fixture.method;
  const directory = mkdtempSync(path.join(tmpdir(), "f5-interactive-perf-"));
  const data = createBrowserFixture();
  const clients = Effect.runSync(Ref.make(new Set<WebSocket>()));
  const controller = makeWebSocketSendController({ clients });
  const scope = Effect.runSync(Scope.make());
  const native = ManagedRuntime.make(NodePtyAdapterLive.pipe(Layer.provide(NodeServices.layer)));
  const pty = await native.runPromise(Effect.service(PtyAdapter));
  const terminals = new TerminalManagerRuntime({
    logsDir: path.join(directory, "terminals"),
    shellResolver: () => process.execPath,
    ptyAdapter: {
      spawn: (input) =>
        pty.spawn({
          ...input,
          shell: process.execPath,
          args: [
            fileURLToPath(new URL("./native-terminal.mjs", import.meta.url)),
            String((minutes + 2) * 60000),
          ],
        }),
    },
  });
  let peakClientBytes = 0;
  let peakPendingFrames = 0;
  let peakPushQueueEvents = 0;
  let offered = 0;
  let sent = 0;
  let frames = 0;
  let streamStartedAt = 0;
  let totalStreamMs = 0;
  let streamTimer: ReturnType<typeof setTimeout> | undefined;
  let streamRunning = false;
  let pumpPromise = Promise.resolve();
  let soakStarted = false;
  let terminalHistoryPeak = 0;
  let terminalDataEvents = 0;
  let terminalActivityEvents = 0;
  terminals.on("event", (event) => {
    if (event.type === "output") terminalDataEvents++;
    if (event.type === "activity") terminalActivityEvents++;
  });
  const bus = await Effect.runPromise(
    makeServerPushBus({
      clients,
      sendClient: controller.send,
      logOutgoingPush: () => {
        sent++;
      },
    }).pipe(Scope.provide(scope)),
  );
  const sampleBuffers = () => {
    peakPushQueueEvents = Math.max(peakPushQueueEvents, offered - sent);
    for (const client of Effect.runSync(Ref.get(clients)))
      peakClientBytes = Math.max(peakClientBytes, controller.logicalOutstandingBytes(client));
  };
  const startStream = () => {
    if (streamRunning) return;
    streamRunning = true;
    streamStartedAt = performance.now();
    let next = streamStartedAt;
    const pump = () => {
      if (!streamRunning) return;
      pumpPromise = (async () => {
        for (const event of data.nextEvents()) {
          offered++;
          await Effect.runPromise(
            bus.publishAll("orchestration.domainEvent", event as OrchestrationEvent),
          );
          sampleBuffers();
        }
        frames++;
        next += 1000 / fixture.streaming.updatesPerSecondPerThread;
        if (streamRunning) streamTimer = setTimeout(pump, Math.max(0, next - performance.now()));
      })();
    };
    pump();
  };
  const stopStream = async () => {
    if (!streamRunning) return;
    streamRunning = false;
    clearTimeout(streamTimer);
    await pumpPromise;
    totalStreamMs += performance.now() - streamStartedAt;
  };
  const inputs = Array.from({ length: fixture.terminal.count }, (_, i) => ({
    threadId: `native-${i}`,
    cwd: directory,
  }));
  const allSockets = new Set<WebSocket>();
  const requests = new Map<string, number>();
  const mime: Record<string, string> = {
    ".js": "text/javascript",
    ".css": "text/css",
    ".woff2": "font/woff2",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".html": "text/html",
  };
  const http = createServer((request, response) => {
    const handle = async () => {
      const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
      const json = (value: unknown) => {
        response.setHeader("Content-Type", "application/json");
        response.end(JSON.stringify(value));
      };
      if (pathname === "/auth/status") return json({ authenticated: true });
      if (pathname.startsWith("/_perf/")) {
        if (request.method !== "POST") {
          response.writeHead(405).end();
          return;
        }
        switch (pathname) {
          case "/_perf/start-streaming":
            startStream();
            break;
          case "/_perf/stop-streaming":
            await stopStream();
            break;
          case "/_perf/start-soak":
            for (const input of inputs) {
              const history = ("terminal 🦊\r\n" + "x".repeat(1000) + "\r\n").repeat(2500);
              writeFileSync(
                path.join(
                  directory,
                  "terminals",
                  `terminal_${Buffer.from(input.threadId).toString("base64url")}.log`,
                ),
                history,
              );
              const snapshot = await terminals.open(input);
              expect(Buffer.byteLength(snapshot.history)).toBeGreaterThan(2_000_000);
              if (snapshot.status !== "running") throw new Error("Native terminal failed to open");
            }
            soakStarted = true;
            startStream();
            break;
          case "/_perf/stop-soak":
            await stopStream();
            break;
          case "/_perf/sample-soak": {
            let bytes = 0;
            for (const input of inputs) {
              const snapshot = await terminals.open(input);
              if (snapshot.status !== "running")
                throw new Error("Native terminal exited during soak");
              const current = Buffer.byteLength(snapshot.history);
              bytes += current;
              terminalHistoryPeak = Math.max(terminalHistoryPeak, current);
            }
            if (typeof globalThis.gc !== "function")
              throw new Error("Server needs --expose-gc for retained heap");
            globalThis.gc();
            const usage = process.memoryUsage();
            return json({
              heapBytes: usage.heapUsed,
              rssBytes: usage.rss,
              terminalHistoryBytes: bytes,
              processCpuMicros: process.cpuUsage(),
            });
          }
          case "/_perf/stats":
            return json({
              frames,
              offered,
              sent,
              peakClientBytes,
              peakPushQueueEvents,
              terminalHistoryPeak,
              terminalDataEvents,
              terminalActivityEvents,
              streamMs: totalStreamMs,
              achievedUpdatesPerSecondPerThread: frames / (totalStreamMs / 1000),
              rpc: Object.fromEntries(requests),
              unknownMethods: [...data.unknownMethods],
            });
          default:
            throw new Error(`Unknown control ${pathname}`);
        }
        return json({ ok: true });
      }
      if (pathname.startsWith("/attachments/")) {
        response.setHeader("Content-Type", "image/png");
        response.end(IMAGE_BYTES);
        return;
      }
      if (pathname.startsWith("/api/")) {
        response.writeHead(204).end();
        return;
      }
      const relative = pathname.replace(/^\/+/, "");
      const dist = path.join(root, "apps/web/dist");
      const candidate = path.resolve(dist, relative);
      if (!candidate.startsWith(dist + path.sep) && candidate !== dist) {
        response.writeHead(403).end();
        return;
      }
      const file =
        path.extname(candidate) && existsSync(candidate)
          ? candidate
          : path.join(dist, "index.html");
      response.setHeader("Content-Type", mime[path.extname(file)] ?? "application/octet-stream");
      response.setHeader(
        "Cache-Control",
        file.endsWith("index.html") ? "no-cache" : "public, max-age=31536000, immutable",
      );
      createReadStream(file).pipe(response);
    };
    void handle().catch((error) => {
      response.writeHead(500);
      response.end(String(error));
    });
  });
  const wss = new WebSocketServer({
    server: http,
    perMessageDeflate: resolveServerPerMessageDeflate(),
  });
  let welcomeSequence = 1;
  wss.on("connection", (socket, request) => {
    allSockets.add(socket);
    socket.on("error", () => {});
    socket.on("close", () => {
      allSockets.delete(socket);
      Effect.runSync(
        Ref.update(clients, (current) => {
          const next = new Set(current);
          next.delete(socket);
          return next;
        }),
      );
    });
    if (request.url?.startsWith("/slow")) return;
    Effect.runSync(Ref.update(clients, (current) => new Set([...current, socket])));
    socket.send(
      JSON.stringify({
        type: "push",
        sequence: welcomeSequence++,
        channel: "server.welcome",
        data: data.welcome,
      }),
    );
    socket.on("message", (raw) => {
      const request = JSON.parse(String(raw));
      const tag = String(request.body?._tag);
      requests.set(tag, (requests.get(tag) ?? 0) + 1);
      void Effect.runPromise(
        controller.send(socket, JSON.stringify({ id: request.id, result: data.rpc(request.body) })),
      );
    });
  });
  const writer = fork(
    fileURLToPath(new URL("./sqlite-writer.mjs", import.meta.url)),
    [path.join(directory, "writer.sqlite"), "bounded"],
    { execArgv: [], stdio: ["ignore", "ignore", "ignore", "ipc"] },
  );
  const writerExited = once(writer, "exit");
  let writerStats: unknown;
  let browserChild: ReturnType<typeof spawn> | undefined;
  const report = {
    schemaVersion: 1,
    scope: "interactive",
    mode: smoke ? "smoke" : "measurement",
    metadata: metadata(root),
    method: { warmups: method.warmups, repetitions: method.repetitions },
    measurements: {} as Record<string, Samples>,
    observations: [] as ReturnType<typeof maximumObservation>[],
    memory: [] as MemorySample[],
    browser: "",
    transportCloseCodes: [] as number[],
    writer: writerStats,
    notMeasured: [] as string[],
    fixtureStats: {},
  };
  try {
    await once(writer, "message", { signal: AbortSignal.timeout(10000) });
    http.listen(0, "127.0.0.1");
    await once(http, "listening");
    const address = http.address();
    if (!address || typeof address === "string") throw new Error("No HTTP address");
    const url = `http://127.0.0.1:${address.port}`;
    report.measurements["transport.slow-disconnecting-client"] = await measure(async () => {
      const connected = once(wss, "connection");
      const peer = new WebSocket(`ws://127.0.0.1:${address.port}/slow`);
      const [socket] = (await connected) as [WebSocket];
      await once(peer, "open");
      peer.pause();
      const frame = JSON.stringify({ text: "x".repeat(1000) });
      let closed = false;
      for (let i = 0; i < 10000; i++) {
        const accepted = await Effect.runPromise(controller.send(socket, frame));
        peakClientBytes = Math.max(peakClientBytes, controller.logicalOutstandingBytes(socket));
        peakPendingFrames = Math.max(
          peakPendingFrames,
          controller.logicalOutstandingBytes(socket) / Buffer.byteLength(frame),
        );
        if (!accepted) {
          closed = true;
          break;
        }
      }
      const closing = once(peer, "close", { signal: AbortSignal.timeout(10000) });
      peer.resume();
      const [code] = await closing;
      report.transportCloseCodes.push(Number(code));
      expect(closed).toBe(true);
      expect([1013, 4409]).toContain(code);
    }, method);
    report.observations.push(
      maximumObservation("transport.logicalBufferedBytes", peakClientBytes, 8 * 1024 * 1024),
    );
    report.observations.push(
      maximumObservation("transport.pendingFrames", peakPendingFrames, 2000),
    );
    const browserOutput = `${output}.browser.json`;
    browserChild = spawn(
      process.execPath,
      [
        path.join(root, "apps/web/scripts/performance-browser.mjs"),
        url,
        browserOutput,
        smoke ? "smoke" : "measurement",
        String(minutes),
      ],
      { stdio: ["ignore", "inherit", "inherit"] },
    );
    const [code] = await once(browserChild, "exit");
    if (code !== 0) throw new Error(`Browser benchmark exited ${code}`);
    const browser = JSON.parse(readFileSync(browserOutput, "utf8"));
    Object.assign(report.measurements, browser.measurements);
    report.memory = browser.memory;
    report.browser = browser.browser;
    report.metadata.browser = browser.browser;
    report.metadata.browserConfig = browser.config;
    report.fixtureStats = browser.loaded;
    report.observations.push(
      maximumObservation(
        "browser.composerInputP95Ms",
        percentile95(report.measurements["browser.composer-input"]!.wallMs),
        100,
      ),
    );
    report.observations.push(
      maximumObservation(
        "browser.streamingComposerInputP95Ms",
        percentile95(report.measurements["browser.composer-input-streaming"]!.wallMs),
        100,
      ),
    );
    report.observations.push(
      maximumObservation(
        "browser.warmSwitchP95Ms",
        percentile95(report.measurements["browser.warm-switch-large"]!.wallMs),
        500,
      ),
    );
    if (minutes === fixture.method.retainedMemoryMinutes)
      report.observations.push(...retainedMemoryObservations(report.memory));
    report.observations.push(
      maximumObservation("transport.pushQueueEvents", peakPushQueueEvents, 2000),
    );
    if (soakStarted) {
      expect(terminalDataEvents).toBeGreaterThan(20);
      expect(terminalActivityEvents).toBeGreaterThanOrEqual(20);
    }
    const stats = once(writer, "message", { signal: AbortSignal.timeout(10000) });
    writer.send("stop");
    [writerStats] = await stats;
    report.writer = writerStats;
    expect(writerStats).toMatchObject({ failures: 0 });
    expect((writerStats as { writes: number }).writes).toBeGreaterThan(0);
    expect(browser.loaded.unknownMethods).toEqual([]);
    expect(
      Math.abs(
        browser.loaded.frames -
          (browser.loaded.streamMs * fixture.streaming.updatesPerSecondPerThread) / 1000,
      ),
    ).toBeLessThanOrEqual(2);
    await writerExited;
    report.observations.push(
      maximumObservation("terminal.nativeHistoryBytes", terminalHistoryPeak, 4 * 1024 * 1024),
    );
  } finally {
    await stopStream();
    if (browserChild && browserChild.exitCode === null && browserChild.signalCode === null) {
      browserChild.kill();
      await once(browserChild, "exit");
    }
    if (writer.exitCode === null && writer.signalCode === null) {
      writer.kill();
      await writerExited;
    }
    for (const input of inputs) await terminals.close(input);
    terminals.dispose();
    await native.dispose();
    for (const socket of allSockets) socket.terminate();
    await new Promise<void>((resolve) => wss.close(() => resolve()));
    await new Promise<void>((resolve) => http.close(() => resolve()));
    await Effect.runPromise(Scope.close(scope, Exit.succeed(undefined)));
    rmSync(directory, { recursive: true, force: true });
  }
  writeFileSync(output, JSON.stringify(report, null, 2) + "\n", { flag: "wx" });
}, 2_400_000);
