import { createRequire } from "node:module";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ComputerAutomationBrokerRuntime } from "../apps/server/src/computer/ComputerAutomationBroker.ts";
import { DesktopComputerHost } from "../apps/server/src/computer/DesktopComputerHost.ts";
import {
  callComputerTool,
  ComputerToolGeometry,
} from "../apps/server/src/computer/computerMcpTools.ts";
import { ComputerController } from "../apps/desktop/src/computer/ComputerController.ts";
import { ComputerLeaseAuthority } from "../apps/desktop/src/computer/ComputerLeaseAuthority.ts";
import { ComputerHelperClient } from "../apps/desktop/src/computer/ComputerHelperClient.ts";
import {
  createRehearsalFixture,
  prepareRehearsalExecutable,
} from "../apps/desktop/src/computer/rehearsalFixture.ts";
import { closeRehearsalChild } from "../apps/desktop/src/computer/rehearsalCleanup.ts";
import {
  COMPUTER_PERFORMANCE_TEXT,
  measureComputerTasks,
  normalizedComputerTreeDigest,
} from "./lib/performance/computerTasks.ts";
import { metadata, percentile95 } from "./lib/performance/report.ts";
import { ComputerPerformanceTransport } from "../apps/desktop/src/computer/computerPerformanceTransport.ts";

const root =
  process.env.F5_COMPUTER_PERF_ROOT ?? resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const argument = (key) => {
  const index = args.indexOf(key);
  return index < 0 ? undefined : args[index + 1];
};
const helperPath = argument("--helper");
const output = argument("--output");
if (
  !helperPath ||
  !output ||
  process.env.F5_COMPUTER_PERFORMANCE !== "1" ||
  !["darwin", "win32"].includes(process.platform)
) {
  throw new Error(
    "Attended synthetic input only: F5_COMPUTER_PERFORMANCE=1 bun scripts/performance.ts computer-tasks --helper <debug-helper> --output <new-report.json> [--fixture-bin-dir <directory>]",
  );
}
// Use Electron's real overlay and main-process controller, not a simulated delay.
if (!process.versions.electron) {
  const scratch = await mkdtemp(join(tmpdir(), "f5-computer-perf-bootstrap-"));
  try {
    const entry = join(scratch, "performance.mjs");
    await promisify(execFile)(
      "bun",
      [
        "build",
        fileURLToPath(import.meta.url),
        "--target=node",
        "--format=esm",
        "--external=electron",
        "--outfile=" + entry,
      ],
      { cwd: root },
    );
    const requireDesktop = createRequire(join(root, "apps/desktop/package.json"));
    await writeFile(
      join(scratch, "package.json"),
      JSON.stringify({
        name: "f5-computer-performance",
        main: "performance.mjs",
        type: "module",
      }),
    );
    const childEnv = { ...process.env, F5_COMPUTER_PERF_ROOT: root };
    delete childEnv.ELECTRON_RUN_AS_NODE;
    const child = spawn(requireDesktop("electron"), [scratch, ...args], {
      cwd: root,
      stdio: "inherit",
      env: childEnv,
    });
    const stop = () => child.kill("SIGTERM");
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    process.exitCode = await new Promise((done, reject) => {
      child.once("exit", (code, signal) => {
        if (code !== 0 || !existsSync(resolve(output)))
          process.stderr.write(
            "Native Electron harness did not complete: " +
              (signal ?? code ?? "unknown exit") +
              ". No performance acceptance is established.\n",
          );
        done(code ?? 1);
      });
      child.once("error", reject);
    });
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
} else {
  const { ComputerOverlay } = await import("../apps/desktop/src/computer/ComputerOverlay.ts");
  const { computerScreenshotThumbnail } =
    await import("../apps/desktop/src/computer/computerThumbnail.ts");
  const { app } = await import("electron");
  await app.whenReady();
  await writeFile(resolve(output), "", { flag: "wx" });
  const scratch = await mkdtemp(join(tmpdir(), "f5-computer-perf-"));
  const helper = new ComputerHelperClient(dirname(resolve(helperPath)), resolve(helperPath));
  const fixtures = new Map();
  const profileId = "computer-performance",
    threadId = randomUUID(),
    generation = randomUUID();
  let controller, broker, host, overlay;
  let interrupted = false,
    calls = 0;
  let preparationMode;
  const stages = new Map(),
    digests = {},
    diagnostics = {};
  const probe = (name, elapsed) => {
    try {
      if (!stages.has(name)) stages.set(name, []);
      stages.get(name).push(elapsed);
    } catch {
      /* Optional diagnostics cannot alter native execution. */
    }
  };
  let measurements = {},
    observations = [],
    startupError;
  let displays = [];
  const stop = () => {
    interrupted = true;
    controller?.stop();
    void helper.suspend().finally(() => {
      helper.close();
      app.exit(1);
    });
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  const nativeRequest = helper.request.bind(helper);
  helper.request = async (...input) => {
    const value = await nativeRequest(...input);
    const image = value?.screenshot ?? value;
    if (typeof image?.secureAudit?.elapsedMs === "number")
      probe("native.secure-audit", image.secureAudit.elapsedMs);
    return value;
  };
  helper.onEvent((packet) => {
    if (packet.type === "accessibilityTraversal") {
      if (typeof packet.visited === "number")
        diagnostics["native.traversal.visited"] = packet.visited;
      if (typeof packet.reported === "number")
        diagnostics["native.traversal.reported"] = packet.reported;
    }
  });
  const text =
    process.platform === "win32" ? "F5_WINDOWS_REHEARSAL Ω🙂" : COMPUTER_PERFORMANCE_TEXT;
  try {
    let compiledFixture;
    if (process.platform === "darwin") {
      compiledFixture = join(scratch, "fixture-executable");
      await prepareRehearsalExecutable(
        join(root, "apps/desktop/native/macos/Fixtures/ComputerControlFixture.swift"),
        compiledFixture,
      );
    }
    for (let index = 0; index < 5; index++) {
      const coldHelper = new ComputerHelperClient(
        dirname(resolve(helperPath)),
        resolve(helperPath),
      );
      let coldFixture;
      try {
        const started = performance.now();
        coldHelper.start();
        const until = started + 5000;
        while (!coldHelper.status().available && performance.now() < until)
          await new Promise((done) => setTimeout(done, 25));
        const status = coldHelper.status();
        if (!status.available) throw new Error("Helper unavailable: " + status.reason);
        const appId =
          process.platform === "win32"
            ? join(scratch, "cold-" + index, "ComputerControlFixture.exe").toLowerCase()
            : "org.example.performance-cold." + randomUUID();
        coldFixture = await createRehearsalFixture({
          root: scratch,
          appId,
          background: true,
          ...(compiledFixture ? { executableSource: compiledFixture } : {}),
          ...(argument("--fixture-bin-dir")
            ? { preparedDirectory: argument("--fixture-bin-dir") }
            : {}),
        });
        diagnostics["cold." + index + ".wallMs"] = performance.now() - started;
      } finally {
        coldHelper.close();
        await closeRehearsalChild(coldFixture?.child);
      }
    }
    helper.start();
    const until = performance.now() + 5000;
    while (!helper.status().available && performance.now() < until)
      await new Promise((done) => setTimeout(done, 25));
    const status = helper.status();
    if (!status.available) throw new Error("Helper unavailable: " + status.reason);
    displays = status.displays ?? [];
    if (displays.length !== 1)
      throw new Error("Matched foreground acceptance requires one display.");
    for (const [size, treeNodes] of [
      ["small", undefined],
      ["large", 380],
      ["delayed-focus", undefined],
    ]) {
      const appId =
        process.platform === "win32"
          ? join(scratch, size, "ComputerControlFixture.exe").toLowerCase()
          : "org.example.computer-performance." + size + "." + randomUUID();
      fixtures.set(size, {
        appId,
        ...(await createRehearsalFixture({
          root: scratch,
          appId,
          expectedText: text,
          ...(compiledFixture ? { executableSource: compiledFixture } : {}),
          ...(size === "delayed-focus" ? { delayedFocus: true } : {}),
          ...(treeNodes ? { treeNodes } : {}),
          ...(argument("--fixture-bin-dir")
            ? { preparedDirectory: argument("--fixture-bin-dir") }
            : {}),
        })),
      });
    }
    overlay = new ComputerOverlay();
    const lease = new ComputerLeaseAuthority();
    controller = new ComputerController(lease, helper, overlay, {
      f5Pids: () => [process.pid, ...app.getAppMetrics().map((entry) => entry.pid)],
      f5BundlePath:
        process.platform === "darwin"
          ? resolve(dirname(process.execPath), "../..")
          : dirname(process.execPath),
      platform: process.platform,
      activity: () => {},
      paused: () => {
        interrupted = true;
      },
      performanceStageProbe: probe,
      thumbnail: computerScreenshotThumbnail,
      cooperationEnabled: () => true,
      targetYielded: () => {
        interrupted = true;
      },
    });
    // In-process transport exercises the real broker, queue, controller, overlay and helper.
    // It grants only the synthetic fixtures, and cannot approve any other app or takeover.
    const allowed = new Set([...fixtures.values()].map((fixture) => fixture.appId));
    const ipc = new ComputerPerformanceTransport({
      controller,
      lease,
      profileId,
      allowedApps: allowed,
      status: () => helper.status(),
      probe,
    });
    host = new DesktopComputerHost(profileId, "computer-performance", ipc, true);
    broker = new ComputerAutomationBrokerRuntime(host, {
      platform: process.platform,
      performanceStageProbe: probe,
      resolve: async () => ({
        threadId,
        sessionGeneration: generation,
        projectId: "computer-performance",
        turnId: "performance",
        provider: "codex",
        runtimeMode: "full-access",
        interactionMode: "default",
        threadTitle: "Synthetic performance fixtures",
        policy: {
          computerUse: true,
          computerUseExecutionMode: "foreground",
          previewAutomation: false,
          externalHosts: [],
          claudeInChrome: false,
          codexChrome: false,
        },
      }),
      storage: {
        load: async () =>
          [...allowed].map((appId) => ({
            projectId: "computer-performance",
            appId,
            tier: "full",
            allowTyping: false,
          })),
        save: async () => {},
      },
    });
    await broker.initialize();
    broker.bindSession(threadId, generation, "codex");
    const context = {
      broker,
      threadId,
      sessionGeneration: generation,
      geometry: new ComputerToolGeometry(),
    };
    broker.subscribe((event) => {
      if (event.channel === "computer.observations.invalidated") context.geometry.clear(true);
    });
    const driver = {
      app: fixtures.get("small").appId,
      text,
      call: async (name, input) => {
        if (interrupted)
          throw new Error("Physical interruption: rehearsal will not resume automatically.");
        calls++;
        const started = performance.now();
        const value = await callComputerTool(context, name, input);
        probe("tool.execution", performance.now() - started);
        if (value.isError)
          throw new Error("Computer tool failed: " + value.structuredContent?.error?._tag);
        return value.structuredContent;
      },
      prepare: async (size, mode) => {
        preparationMode = mode;
        const fixture = fixtures.get(mode === "delayed-focus" ? "delayed-focus" : size);
        driver.app = fixture.appId;
        await fixture.reset();
        await driver.call("computer_activate_app", { app: driver.app, screenshot: false });
        const snapshot = await driver.call("computer_inspect", { app: driver.app });
        const input = snapshot.nodes.find((node) => node.name === "Rehearsal input");
        if (!input) throw new Error("Synthetic input is missing.");
        const focus = await driver.call("computer_element_action", {
          app: driver.app,
          snapshotId: snapshot.snapshotId,
          elementRef: input.ref,
          action: "focus",
          screenshot: false,
        });
        if (focus.verification?.verified !== true)
          throw new Error("Preparation focus did not verify.");
        // Observation also waits out any deferred settle, outside the timed sample.
        await driver.call("computer_inspect", { app: driver.app });
        if (mode === "delayed-focus")
          await fixture.command(
            process.platform === "win32" ? "performance-blur" : "PERF_BLUR",
            "FIXTURE_BLURRED",
          );
        if (mode === "delayed") {
          context.geometry.clear();
          await fixture.command(
            process.platform === "win32" ? "performance-delayed-button" : "PERF_DELAY_BUTTON",
            "FIXTURE_DELAY_SCHEDULED",
          );
        }
        if (mode === "changing")
          await fixture.command(
            process.platform === "win32" ? "performance-changing" : "PERF_CHANGING",
            "FIXTURE_CHANGING_READY",
          );
      },
      verify: () => {
        if (preparationMode === "delayed" && ipc.resolutions !== 1)
          throw new Error("Conditional wait must resolve its app exactly once.");
        return [...fixtures.values()].find((fixture) => fixture.appId === driver.app).verify();
      },
      resetCalls: () => {
        calls = 0;
        diagnostics.resolutions = 0;
        ipc.resolutions = 0;
      },
      calls: () => calls,
      inspection: (name, value) => {
        const digest = normalizedComputerTreeDigest(value);
        if (digests[name] && digests[name] !== digest)
          throw new Error("Complete inspection output changed between samples.");
        digests[name] = digest;
      },
      overlay: async (animated) => {
        const display = displays[0];
        diagnostics.overlayPoint = diagnostics.overlayPoint === 20 ? 80 : 20;
        const request = animated
          ? {
              op: "move",
              displayId: display.displayId,
              x: diagnostics.overlayPoint,
              y: 20,
              agent: { provider: "codex" },
            }
          : { op: "type", text, agent: { provider: "codex" } };
        await overlay.action(request, displays);
      },
    };
    ({ measurements, observations } = await measureComputerTasks(driver));
    for (const [name, values] of stages) diagnostics[name + ".p95Ms"] = percentile95(values);
  } catch (cause) {
    startupError = cause.message.startsWith("Helper unavailable:")
      ? cause.message
      : "Harness startup or native execution failed.";
    process.stderr.write(startupError + "\n");
    observations.push({ name: "native-startup.failures", actual: 1, maximum: 0, passed: false });
  } finally {
    broker?.close();
    host?.close();
    controller?.close();
    overlay?.close();
    await helper.suspend();
    helper.close();
    for (const fixture of fixtures.values()) await closeRehearsalChild(fixture.child);
    const hashFiles = async (files) =>
      createHash("sha256")
        .update(Buffer.concat(await Promise.all(files.map((file) => readFile(join(root, file))))))
        .digest("hex");
    const report = {
      schemaVersion: 1,
      scope: "computer",
      mode: "measurement",
      metadata: metadata(root),
      method: { warmups: 5, repetitions: 30 },
      measurements,
      observations,
      diagnostics,
      notMeasured: [
        "CPU is driving Electron main only; helper and renderer CPU are not measured.",
        "Backend-to-main transport is in-process; production IPC serialization and external MCP transport are not measured.",
        "Provider/model turns and attended Windows 11 validation are not measured.",
      ],
      computer: {
        fixtureDigest: await hashFiles([
          "apps/desktop/native/macos/Fixtures/ComputerControlFixture.swift",
          "apps/desktop/native/windows/fixture/src/window.rs",
          "apps/desktop/native/windows/fixture/src/lib.rs",
        ]),
        harnessDigest: await hashFiles([
          "scripts/performance-computer.mjs",
          "scripts/lib/performance/computerTasks.ts",
          "apps/desktop/src/computer/rehearsalFixture.ts",
          "apps/desktop/src/computer/computerPerformanceTransport.ts",
          "apps/desktop/src/computer/computerInspectionRehearsal.ts",
        ]),
        helperIdentity: createHash("sha256")
          .update(await readFile(resolve(helperPath)))
          .digest("hex"),
        desktopIdentity: await hashFiles([
          "apps/desktop/src/computer/ComputerController.ts",
          "apps/desktop/src/computer/ComputerOverlay.ts",
          "apps/desktop/src/computer/computerThumbnail.ts",
          "apps/server/src/computer/computerMcpTools.ts",
          "apps/server/src/computer/ComputerAutomationBroker.ts",
        ]),
        platform: process.platform,
        coverage: "tasks",
        displays: displays.map(({ displayId, nativeBounds, modelSize, pixelSize, rotation }) => ({
          displayId,
          nativeBounds,
          modelSize,
          pixelSize,
          rotation,
        })),
        masking: "fast",
        build: "debug-unsigned-in-process-transport",
        executionMode: "foreground",
        nodesDigests: digests,
      },
    };
    await writeFile(resolve(output), JSON.stringify(report, null, 2) + "\n");
    await rm(scratch, { recursive: true, force: true });
    const failed =
      startupError ||
      observations.some((value) => !value.passed) ||
      Object.keys(measurements).length !== 14;
    app.exit(failed ? 1 : 0);
  }
}
