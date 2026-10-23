import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inventory } from "./catalog";
import {
  coverage,
  decodeManifest,
  decodeResult,
  digest,
  pending,
  sameIdentity,
  type Manifest,
  type ScenarioResult,
} from "./model";
import { commandsFor } from "./commands";
import { summarizeEvidence } from "./evidence";
import {
  initialize,
  loadManifest,
  loadResults,
  saveResult,
  writeExclusive,
  attemptName,
  lockSuite,
} from "./store";
import { recoverInterrupted } from "./suite";
import { cleanEnvironment } from "./process";

const hash = "a".repeat(64);
const manifest: Manifest = {
  version: 1,
  suiteId: "test-suite",
  preparedAt: "2026-10-13T12:00:00Z",
  identity: {
    platform: "darwin",
    arch: "arm64",
    commit: "b".repeat(40),
    dirty: false,
    target: "development",
    files: { helper: hash },
  },
  providers: ["codex", "claude"],
  prerequisites: {},
};
const scenario = (id: string) => inventory("darwin", manifest.providers).find((s) => s.key === id)!;
function result(
  key = "quality",
  state: ScenarioResult["state"] = "passed",
  attempt = 1,
): ScenarioResult {
  return {
    version: 1,
    suiteId: manifest.suiteId,
    scenario: key,
    attempt,
    identityHash: digest(manifest.identity),
    state,
    evidenceKind: key === "quality" ? "automated" : "provider-desktop",
    startedAt: manifest.preparedAt,
    finishedAt: manifest.preparedAt,
    checks: Object.fromEntries(scenario(key).expectedChecks.map((c) => [c, true])),
    measurements: {},
    cleanup: "confirmed",
    evidenceSha256: hash,
  };
}
const roots: string[] = [];
async function directory() {
  const root = await mkdtemp(join(tmpdir(), "f5-certification-test-"));
  roots.push(root);
  return root;
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((r) => rm(r, { recursive: true, force: true })));
});

describe("certification inventory and coverage", () => {
  it("uses real Codex profile phases only in development and retains unavailable platform/integration gates", () => {
    for (const key of ["profile-isolation", "profile-readiness", "profile-inspection-diagnostic"]) {
      const s = scenario(key);
      const target = { repo: "/repo", platform: "darwin" as const };
      const launch = { codex: { home: "/private/home", binary: "/cli/codex" } };
      const commands = commandsFor(s, target, "/private/output", launch, "darwin");
      expect(Array.isArray(commands)).toBe(true);
      if (Array.isArray(commands))
        expect(commands[0]?.args).toContain(
          key === "profile-inspection-diagnostic"
            ? "--profile-inspection-diagnostic"
            : key === "profile-readiness"
              ? "--profile-isolation-readonly"
              : "--profile-isolation",
        );
      expect(
        commandsFor(s, { ...target, app: "/private/Installed.app" }, "/output", launch, "darwin"),
      ).toBe("installed-observation-driver-required");
      expect(commandsFor(s, { ...target, platform: "win32" }, "/output", launch, "win32")).toBe(
        "windows-interactive-driver-required",
      );
      expect(commandsFor(s, target, "/output", {}, "darwin")).toBe(
        "provider-launch-not-configured",
      );
    }
  });

  it("runs the provider-native live checks only on a Mac and keeps Claude's built-in gated", () => {
    const target = { repo: "/repo", platform: "darwin" as const };
    const launch = { claude: { home: "/private/claude", binary: "/cli/claude" } };
    const env = (key: string) => {
      const commands = commandsFor(scenario(key), target, "/out", launch, "darwin");
      return Array.isArray(commands) ? commands[0]?.env : commands;
    };
    expect(env("chrome.codex")).toMatchObject({ F5_CODEX_NATIVE_LIVE: "chrome" });
    expect(env("builtin.codex")).toMatchObject({ F5_CODEX_NATIVE_LIVE: "computer" });
    expect(env("chrome.claude")).toMatchObject({ F5_CLAUDE_CHROME_LIVE: "1" });
    expect(env("builtin.claude")).toBe("supported-launch-consent-veto-unavailable");
    expect(commandsFor(scenario("chrome.codex"), target, "/out", launch, "win32")).toBe(
      "interactive-platform-unavailable",
    );
  });

  it("runs a selected new phase without redoing prior phases or hiding missing coverage", () => {
    expect(
      pending(manifest, [], "workflows", undefined, "real-apps.codex").map((s) => s.key),
    ).toEqual(["real-apps.codex"]);
    expect(
      pending(
        manifest,
        [result("real-apps.codex", "failed")],
        "workflows",
        undefined,
        "real-apps.codex",
      ),
    ).toEqual([]);
    expect(coverage(manifest, [result("real-apps.codex")]).nativeReleaseReady).toBe(false);
    expect(() => pending(manifest, [], "recovery", undefined, "real-apps.codex")).toThrow(
      "Unknown",
    );
    expect(() => pending(manifest, [], "workflows", "real-apps.codex", "real-apps.codex")).toThrow(
      "Invalid",
    );
  });
  it("contains both providers and keeps permission revocation last in recovery", () => {
    const mac = inventory("darwin", manifest.providers);
    expect(new Set(mac.map((s) => s.key)).size).toBe(mac.length);
    expect(mac.some((s) => s.key === "fixture-workflow.codex")).toBe(true);
    expect(mac.some((s) => s.key === "fixture-workflow.claude")).toBe(true);
    expect(mac.filter((s) => s.group === "recovery").at(-1)?.id).toBe("permissions");
    expect(mac.some((s) => s.id === "windows-recipients")).toBe(false);
    expect(inventory("win32", manifest.providers).some((s) => s.id === "windows-recipients")).toBe(
      true,
    );
    expect(inventory("win32", manifest.providers).some((s) => s.id === "windows-closed")).toBe(
      false,
    );
  });
  it("includes native Windows fixture tests and no-window protocol checks in readiness", () => {
    const s = inventory("win32", manifest.providers).find((item) => item.id === "native-tests")!;
    expect(s.expectedChecks).toContain("native-fixture-tests");
    expect(s.expectedChecks).toContain("native-fixture-protocol");
    const commands = commandsFor(s, { repo: "/repo", platform: "win32" }, "/result", {}, "win32");
    if (typeof commands === "string") throw new Error("No native readiness driver");
    const probe = commands.find((item) => item.check === "native-fixture-protocol");
    expect(probe?.args).toContain("--check");
    expect(probe?.args).not.toContain("--run");
    expect(commandsFor(s, { repo: "/repo", platform: "win32" }, "/result", {}, "darwin")).toBe(
      "interactive-platform-unavailable",
    );
  });
  it("clusters UI and real-app checks with separate acceptance sets", () => {
    const s = scenario("fixture-workflow.codex");
    expect(scenario("real-apps.codex").expectedChecks).toContain(
      "savedTestDocumentMatchesExpectedText",
    );
    expect(s.expectedChecks).toContain("humanPauseMirrored");
    expect(
      inventory("darwin", manifest.providers).filter((r) => r.id === "real-apps"),
    ).toHaveLength(2);
    const commands = commandsFor(
      s,
      { repo: "/repo", platform: "darwin" },
      "/tmp/result",
      { codex: { home: "/selected", binary: "/codex" } },
      "darwin",
      true,
    );
    if (typeof commands === "string") throw new Error("No driver");
    expect(commands[0]?.args).toContain("--cluster-workflows");
  });
  it("keeps Chromium controls distinct from AppKit and never launches its dev driver against installed apps", () => {
    const s = scenario("chromium-workflow.claude");
    expect(s.expectedChecks).toContain("chromiumFixtureNativeInputObserved");
    const launch = { claude: { home: "/selected", binary: "/claude" } };
    const commands = commandsFor(
      s,
      { repo: "/repo", platform: "darwin", fixtureDirectory: "/prepared" },
      "/result",
      launch,
      "darwin",
    );
    if (typeof commands === "string") throw new Error("No Chromium driver");
    expect(commands[0]?.args).toContain("--chromium-fixture");
    expect(commands[0]?.args).not.toContain("--cluster-workflows");
    expect(
      commandsFor(
        s,
        { repo: "/repo", platform: "darwin", app: "/Installed.app" },
        "/result",
        launch,
        "darwin",
      ),
    ).toBe("installed-observation-driver-required");
  });
  it("runs the windowless observer only in an unpackaged macOS provider phase", () => {
    const s = scenario("windows-closed.claude");
    const launches = { claude: { home: "/selected", binary: "/claude" } };
    const commands = commandsFor(
      s,
      { repo: "/repo", platform: "darwin" },
      "/result",
      launches,
      "darwin",
    );
    if (typeof commands === "string") throw new Error("No windowless driver");
    expect(commands[0]?.args).toContain("--windows-closed");
    expect(
      commandsFor(
        s,
        { repo: "/repo", platform: "darwin", app: "/Installed.app" },
        "/result",
        launches,
        "darwin",
      ),
    ).toBe("installed-observation-driver-required");
    expect(s.expectedChecks).toContain("humanFinishAcknowledged");
    expect(s.expectedChecks).toContain("externalSubmissionsOnce");
  });

  it("keeps the prepared grant memory phase separate from the complete consent matrix", () => {
    const s = scenario("grant-memory.claude");
    const launches = { claude: { home: "/selected", binary: "/claude" } };
    const commands = commandsFor(
      s,
      { repo: "/repo", platform: "darwin" },
      "/result",
      launches,
      "darwin",
    );
    if (typeof commands === "string") throw new Error("No grant memory driver");
    expect(commands[0]?.args).toContain("--grant-memory");
    expect(commands[0]?.args).not.toContain("--cluster-workflows");
    expect(
      commandsFor(
        s,
        { repo: "/repo", platform: "darwin", app: "/Installed.app" },
        "/result",
        launches,
        "darwin",
      ),
    ).toBe("installed-observation-driver-required");
    expect(scenario("grant-lifecycle.claude").expectedChecks).toContain("session-actions");
    expect(s.expectedChecks).not.toContain("session-actions");
    expect(
      coverage(manifest, [result(s.key)]).requirements.find(
        (requirement) => requirement.requirement === "consent",
      )?.state,
    ).toBe("pending");
    const raw = {
      reportVersion: 1,
      platform: "darwin",
      helperSha256: hash,
      state: "passed",
      scope: "unsigned-real-electron-claude-grant-memory",
      checks: result(s.key).checks,
      cleanup: { confirmed: true },
    };
    expect(summarizeEvidence(s, manifest, raw).state).toBe("failed");
  });

  it("prepares approval-mode consent separately without crediting the complete consent gate", () => {
    const s = scenario("session-actions.claude");
    const launches = { claude: { home: "/selected", binary: "/claude" } };
    const commands = commandsFor(
      s,
      { repo: "/repo", platform: "darwin" },
      "/result",
      launches,
      "darwin",
    );
    if (typeof commands === "string") throw new Error("No session actions driver");
    expect(commands[0]?.args).toContain("--session-actions");
    expect(
      commandsFor(
        s,
        { repo: "/repo", platform: "darwin", app: "/Installed.app" },
        "/result",
        launches,
        "darwin",
      ),
    ).toBe("installed-observation-driver-required");
    expect(
      coverage(manifest, [result(s.key)]).requirements.find((r) => r.requirement === "consent")
        ?.state,
    ).toBe("pending");
    expect(
      summarizeEvidence(s, manifest, {
        reportVersion: 1,
        platform: "darwin",
        helperSha256: hash,
        state: "passed",
        scope: "unsigned-real-electron-claude-session-actions",
        checks: result(s.key).checks,
        cleanup: { confirmed: true },
      }).state,
    ).toBe("failed");
  });

  it("requires independent windowless receipts, never only passing assertion flags", () => {
    const s = scenario("windows-closed.claude");
    const raw = {
      reportVersion: 1,
      platform: "darwin",
      helperSha256: hash,
      scope: "unsigned-real-electron-claude-all-app-windows-closed",
      state: "passed",
      checks: result(s.key).checks,
      cleanup: { confirmed: true },
      externalSubmissions: 1,
      providerTailObserved: true,
      providerErrorCodes: [],
      stopScope: "session-stop-after-completed-native-actions",
      consentObservation: {
        requested: true,
        trustedClick: true,
        settled: true,
        allowed: true,
        fixtureGranted: true,
      },
      windowlessObservation: {
        active: true,
        reopened: false,
        inputWithWindow: false,
        mutationAdmissions: 4,
        finalWindowCount: 0,
      },
      windowlessStopObservation: { sessionStopped: true, grantsCleared: true, leaseReleased: true },
      fixtureObservation: {
        presses: 1,
        expectedSyntheticTextReceived: true,
        humanFinishAcknowledged: true,
      },
      nativeObservation: {
        pendingResponses: 0,
        traceComplete: true,
        responses: {
          nativeCaptureSucceeded: true,
          nativeInspectionSucceeded: true,
          nativeInputSucceeded: true,
        },
        operations: [
          { op: "activateApp", outcome: "ok", actionCompleted: true, actionCaptureSucceeded: true },
          { op: "screenshot", outcome: "ok" },
          { op: "inspect", outcome: "ok" },
          { op: "elementAction", action: "press", outcome: "ok" },
          { op: "elementAction", action: "focus", outcome: "ok" },
          { op: "type", outcome: "ok" },
        ],
      },
    };
    expect(summarizeEvidence(s, manifest, raw).state).toBe("passed");
    for (const patch of [
      { nativeObservation: undefined },
      { nativeObservation: { ...raw.nativeObservation, pendingResponses: 1 } },
      {
        nativeObservation: {
          ...raw.nativeObservation,
          operations: [...raw.nativeObservation.operations, { op: "type", outcome: "ok" }],
        },
      },
      {
        nativeObservation: {
          ...raw.nativeObservation,
          operations: raw.nativeObservation.operations.filter((op) => op.action !== "focus"),
        },
      },
      {
        nativeObservation: {
          ...raw.nativeObservation,
          operations: [
            ...raw.nativeObservation.operations,
            { op: "inspect", outcome: "Execution" },
          ],
        },
      },
      { windowlessObservation: { ...raw.windowlessObservation, reopened: true } },
      { windowlessObservation: { ...raw.windowlessObservation, inputWithWindow: true } },
      { windowlessObservation: { ...raw.windowlessObservation, finalWindowCount: 1 } },
      { windowlessStopObservation: { ...raw.windowlessStopObservation, grantsCleared: false } },
      { consentObservation: { ...raw.consentObservation, trustedClick: false } },
      { fixtureObservation: { ...raw.fixtureObservation, humanFinishAcknowledged: false } },
      { externalSubmissions: 2 },
      { providerTailObserved: false },
      { providerErrorCodes: ["OutcomeUnknown"] },
      { stopScope: "in-flight-under-100ms" },
      { scope: "fake-host" },
    ])
      expect(summarizeEvidence(s, manifest, { ...raw, ...patch }).state).toBe("failed");
    expect(
      summarizeEvidence(
        s,
        { ...manifest, identity: { ...manifest.identity, target: "installed" } },
        raw,
      ).state,
    ).toBe("failed");
  });

  it("keeps completed fixture proof separate when the later real-app phase fails", () => {
    const s = scenario("fixture-workflow.codex");
    const checks = result(s.key).checks;
    const raw = {
      reportVersion: 1,
      platform: "darwin",
      helperSha256: hash,
      state: "failed",
      checks: { ...checks, later: false },
      cleanup: { confirmed: true },
      phaseEvidence: {
        fixture: { checks, state: "passed" },
        realApps: { checks: { later: false }, state: "failed" },
      },
    };
    expect(summarizeEvidence(s, manifest, raw).state).toBe("passed");
    expect(summarizeEvidence(scenario("real-apps.codex"), manifest, raw).state).toBe("failed");
  });
  it("does not equate a passing software suite with machine or installed proof", () => {
    const report = coverage(manifest, [result()]);
    expect(report.requirements.find((r) => r.requirement === "consent")?.state).toBe("pending");
    expect(report.nativeReleaseReady).toBe(false);
    expect(report.gatesChanged).toBe(false);
  });
  it("requires both provider records, signed installed evidence and final review", () => {
    expect(coverage({ ...manifest, providers: ["codex"] }, [result()]).nativeReleaseReady).toBe(
      false,
    );
    expect(
      coverage(
        {
          ...manifest,
          identity: { ...manifest.identity, target: "installed" },
          prerequisites: { "app-signature": true, "helper-signature": true },
        },
        [],
      ).nativeReleaseReady,
    ).toBe(false);
  });
  it("preserves failures and uses only the latest explicit attempt", () => {
    const attempts = [result("quality", "failed"), result("quality", "passed", 2)];
    expect(coverage(manifest, attempts).rows.find((r) => r.scenario === "quality")).toMatchObject({
      state: "passed",
      attempts: 2,
    });
    expect(attempts[0]?.state).toBe("failed");
    expect(
      pending(manifest, attempts, "automated", undefined).some((r) => r.key === "quality"),
    ).toBe(false);
    expect(() => coverage(manifest, [result(), result()])).toThrow("Duplicate");
  });
  it("does not automatically retry failed, blocked or interrupted work", () => {
    for (const state of ["failed", "blocked", "not-run"] as const) {
      expect(
        pending(manifest, [result("quality", state)], "automated", undefined).some(
          (r) => r.key === "quality",
        ),
      ).toBe(false);
      expect(
        pending(manifest, [result("quality", state)], "automated", "quality").map((r) => r.key),
      ).toEqual(["quality"]);
    }
  });
});
describe("proof validation", () => {
  it("accepts only a current admitted receipt for the matching architecture and provider", () => {
    const s = scenario("fixture-workflow.codex");
    const admission = {
      id: "new-admission",
      startedAt: "2026-10-13T12:00:00Z",
      finishedAt: "2026-10-13T12:01:00Z",
    };
    const raw = {
      reportVersion: 1,
      admissionId: admission.id,
      recordedAt: "2026-10-13T12:00:30Z",
      platform: "darwin",
      arch: "arm64",
      provider: "codex",
      helperSha256: hash,
      state: "passed",
      checks: result(s.key).checks,
      cleanup: { confirmed: true },
    };
    expect(summarizeEvidence(s, manifest, raw, admission).state).toBe("passed");
    for (const patch of [
      { admissionId: "old-admission" },
      { recordedAt: undefined },
      { recordedAt: "2026-10-13T11:59:59Z" },
      { recordedAt: "2026-10-13T12:01:01Z" },
      { arch: "x64" },
      { provider: "claude" },
    ])
      expect(() => summarizeEvidence(s, manifest, { ...raw, ...patch }, admission)).toThrow(
        "admission",
      );
    expect(() =>
      summarizeEvidence(s, manifest, raw, { ...admission, finishedAt: "2026-10-13T11:59:59Z" }),
    ).toThrow("admission");
  });
  it.each([
    { checks: {} },
    { checks: { format: true } },
    { checks: { format: "true" } },
    { cleanup: "unconfirmed" },
    { evidenceSha256: undefined },
    { identityHash: "0".repeat(64) },
    { finishedAt: "invalid" },
    { finishedAt: "2020-01-01T00:00:00Z" },
    { measurements: { tail: Infinity } },
    { measurements: { tail: -1 } },
    { attempt: 0 },
    { scenario: "unknown" },
    { reason: "sensitive detail" },
    { evidenceKind: "installed" },
  ])("rejects missing, malformed or stale evidence %j", (patch) => {
    expect(() => decodeResult({ ...result(), ...patch }, manifest)).toThrow();
  });
  it("rejects a fake/native host summary for a provider desktop workflow", () => {
    expect(() =>
      decodeResult(
        { ...result("fixture-workflow.codex"), evidenceKind: "native-helper" },
        manifest,
      ),
    ).toThrow("Incomplete");
  });
  it("drops arbitrary payloads and credentials from saved summaries", () => {
    const decoded = decodeResult(
      {
        ...result(),
        text: "SECRET_SENTINEL",
        nested: { error: "SECRET_SENTINEL" },
        data: "SECRET_SENTINEL",
      },
      manifest,
    );
    expect(JSON.stringify(decoded)).not.toContain("SECRET_SENTINEL");
    expect(JSON.stringify(decodeManifest({ ...manifest, home: "SECRET_SENTINEL" }))).not.toContain(
      "SECRET_SENTINEL",
    );
  });
  it("detects hash, source, architecture and target changes", () => {
    expect(
      sameIdentity(manifest.identity, { ...manifest.identity, files: { helper: "0".repeat(64) } }),
    ).toBe(false);
    expect(sameIdentity(manifest.identity, { ...manifest.identity, arch: "x64" })).toBe(false);
    expect(sameIdentity(manifest.identity, { ...manifest.identity, target: "installed" })).toBe(
      false,
    );
  });
  it("requires cleanup and the complete native protection assertion list", () => {
    const s = scenario("protected-apps");
    const raw = {
      reportVersion: 1,
      platform: "darwin",
      helperSha256: hash,
      state: "passed",
      checks: Array.from({ length: 13 }, () => ({ state: "passed" })),
      cleanup: { confirmed: true },
      text: "SECRET_SENTINEL",
    };
    expect(summarizeEvidence(s, manifest, raw).state).toBe("passed");
    expect(summarizeEvidence(s, manifest, { ...raw, checks: [{ state: "passed" }] }).state).toBe(
      "failed",
    );
    expect(summarizeEvidence(s, manifest, { ...raw, cleanup: { confirmed: false } }).state).toBe(
      "failed",
    );
    expect(JSON.stringify(summarizeEvidence(s, manifest, raw))).not.toContain("SECRET_SENTINEL");
  });
  it("rejects a passing stop label with uncertain timing or absent clock checks", () => {
    const s = scenario("main-stop.codex");
    const raw = {
      reportVersion: 1,
      platform: "darwin",
      helperSha256: hash,
      state: "passed",
      checks: result(s.key).checks,
      cleanup: { confirmed: true },
      stopMeasurement: {
        state: "passed",
        checks: { clocksValid: false },
        physicalInputTailMs: 0,
        killChordTailMs: 0,
        appDeliveryTailMs: 0,
      },
    };
    expect(summarizeEvidence(s, manifest, raw).state).toBe("failed");
    expect(() => summarizeEvidence(s, manifest, { ...raw, helperSha256: "0".repeat(64) })).toThrow(
      "identity",
    );
  });
  it("does not replace failed workflow assertions with a passing stop measurement", () => {
    const s = scenario("main-stop.codex");
    const stopChecks = Object.fromEntries(
      [
        "traceComplete",
        "clocksValid",
        "syntheticInputObserved",
        "physicalInputRecognized",
        "chordRecognized",
        "promptedBeforeInterruption",
        "typingActiveAtTrigger",
        "physicalStopUnder100Ms",
        "chordStopUnder100Ms",
        "appDeliveryStoppedUnder100Ms",
        "quietTailObserved",
        "inFlightMutationInterrupted",
        "pausedMutationRefused",
        "leaseReleased",
        "fixtureStillFrontmost",
        "stallClockCalibrated",
        "physicalAndChordDuringHostStall",
      ].map((key) => [key, true]),
    );
    const raw = {
      reportVersion: 1,
      platform: "darwin",
      helperSha256: hash,
      state: "passed",
      checks: result(s.key).checks,
      cleanup: { confirmed: true },
      stopMeasurement: {
        state: "passed",
        checks: stopChecks,
        physicalInputTailMs: 0,
        killChordTailMs: 0,
        appDeliveryTailMs: 0,
        clockUncertaintyMs: 1,
        hostStallDurationMs: 700,
      },
    };
    expect(summarizeEvidence(s, manifest, raw).state).toBe("passed");
    expect(summarizeEvidence(s, manifest, { ...raw, checks: {} }).state).toBe("failed");
    expect(
      summarizeEvidence(s, manifest, {
        ...raw,
        stopMeasurement: { ...raw.stopMeasurement, clockUncertaintyMs: 26 },
      }).state,
    ).toBe("failed");
    expect(
      summarizeEvidence(s, manifest, {
        ...raw,
        stopMeasurement: {
          ...raw.stopMeasurement,
          checks: Object.fromEntries(Array.from({ length: 17 }, (_, i) => ["arbitrary" + i, true])),
        },
      }).state,
    ).toBe("failed");
  });
  it("never launches the development wrapper against an installed app", () => {
    expect(
      commandsFor(
        scenario("fixture-workflow.codex"),
        { repo: "/repo", platform: "darwin", app: "/F5.app" },
        "/tmp/result",
        {},
        "darwin",
      ),
    ).toBe("installed-observation-driver-required");
  });
  it("cleans leaked provider/profile env before child commands", () => {
    process.env.F5_TEST_PROFILE_LEAK = "SECRET_SENTINEL";
    try {
      expect(cleanEnvironment()).not.toHaveProperty("F5_TEST_PROFILE_LEAK");
    } finally {
      delete process.env.F5_TEST_PROFILE_LEAK;
    }
  });
});
describe("immutable admissions and interrupted recovery", () => {
  it("refuses manifest/result replacement and reads only valid attempts", async () => {
    const root = await directory();
    await initialize(root, manifest);
    expect(await loadManifest(root)).toEqual(manifest);
    await expect(initialize(root, manifest)).rejects.toThrow();
    await saveResult(root, manifest, result());
    await expect(saveResult(root, manifest, result())).rejects.toThrow();
    expect(await loadResults(root, manifest)).toEqual([result()]);
    expect((await readdir(root)).some((name) => name.endsWith(".tmp"))).toBe(false);
  });
  it("latches an unfinished admission as outcome-unknown without retrying input", async () => {
    const root = await directory();
    await initialize(root, manifest);
    const started = result("fixture-workflow.codex", "not-run");
    await writeExclusive(join(root, attemptName(started.scenario, 1) + ".started.json"), started);
    const results: ScenarioResult[] = [];
    await recoverInterrupted(root, manifest, results);
    expect(results[0]).toMatchObject({
      state: "failed",
      reason: "outcome-unknown",
      cleanup: "unconfirmed",
    });
    expect(
      pending(manifest, results, "workflows", undefined).some((r) => r.key === started.scenario),
    ).toBe(false);
    await recoverInterrupted(root, manifest, results);
    expect((await readdir(root)).filter((n) => n.endsWith(".result.json"))).toHaveLength(1);
  });
  it("refuses concurrent runners and live-lock recovery", async () => {
    const root = await directory();
    const release = await lockSuite(root, false);
    await expect(lockSuite(root, false)).rejects.toThrow("already admitted");
    await expect(lockSuite(root, true)).rejects.toThrow("still be active");
    await release();
    const next = await lockSuite(root, false);
    await next();
  });
});
