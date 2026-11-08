import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
  ComputerAutomationError,
  ComputerAutomationRequest,
  ComputerAutomationBackendStatus,
  ComputerInspectResult,
  ComputerScreenshot,
  RememberedComputerConsent,
  DesktopComputerHostMessage,
  ComputerExecutionState,
  ComputerInterruptionCause,
  ComputerTargetReadiness,
  ComputerTargetAvailability,
  isComputerUserActiveDetail,
} from "./computerAutomation";

describe("computer observation and error metadata", () => {
  it("decodes app keys and mutually exclusive coordinate/element scroll requests", () => {
    const base = {
      requestId: "r",
      payloadHash: "0".repeat(64),
      deadlineAtMs: 1,
      authorization: {
        profileId: "p",
        threadId: "t",
        sessionGeneration: "s",
        turnId: "turn",
        executionGeneration: 1,
        grantVersion: 1,
        grants: [],
      },
      agent: { provider: "claude", threadTitle: "Thread" },
    };
    const element = {
      ...base,
      op: "scroll",
      delivery: "background",
      appId: "app",
      snapshotId: "snapshot",
      elementRef: "element",
      deltaX: 0,
      deltaY: 3,
    };
    const coordinates = {
      ...base,
      op: "scroll",
      displayId: "display",
      geometryGeneration: "g",
      x: 10,
      y: 10,
      deltaX: 0,
      deltaY: 3,
    };
    for (const request of [
      element,
      coordinates,
      { ...base, op: "key", appId: "app", chords: ["Down"], repeat: 1 },
    ])
      expect(Schema.decodeUnknownSync(ComputerAutomationRequest)(request)).toEqual(request);
    expect(() =>
      Schema.decodeUnknownSync(ComputerAutomationRequest)({ ...coordinates, ...element }),
    ).toThrow();
    expect(
      Schema.decodeUnknownSync(ComputerAutomationError)({
        _tag: "TargetBlocked",
        kind: "shared-focus",
      }),
    ).toEqual({ _tag: "TargetBlocked", kind: "shared-focus" });
  });
  it("round-trips the optional user-active detail on errors and target availability", () => {
    for (const error of [
      { _tag: "TargetBlocked", kind: "user-active" },
      { _tag: "TargetBlocked", kind: "user-active", detail: "input-held" },
    ])
      expect(Schema.decodeUnknownSync(ComputerAutomationError)(error)).toEqual(error);
    // A value a newer peer adds must not break the transport; it is only diagnostic.
    const future = { _tag: "TargetBlocked", kind: "user-active", detail: "remote-session" };
    expect(Schema.decodeUnknownSync(ComputerAutomationError)(future)).toEqual(future);
    expect(isComputerUserActiveDetail("remote-session")).toBe(false);
    expect(isComputerUserActiveDetail("input-held")).toBe(true);
    const availability = {
      available: false,
      timedOut: true,
      reason: "user-active",
      detail: "recent-input",
      requiresFreshObservation: true,
    };
    expect(Schema.decodeUnknownSync(ComputerTargetAvailability)(availability)).toEqual(
      availability,
    );
    const { detail: _detail, ...withoutDetail } = availability;
    expect(Schema.decodeUnknownSync(ComputerTargetAvailability)(withoutDetail)).toEqual(
      withoutDetail,
    );
    expect(
      Schema.decodeUnknownSync(ComputerTargetAvailability)({ ...availability, detail: "new" }),
    ).toEqual({ ...availability, detail: "new" });
  });
  it.each(["waiting-user", "waiting-agent"])("decodes execution state %s", (state) => {
    expect(Schema.decodeUnknownSync(ComputerExecutionState)(state)).toBe(state);
  });
  it.each([
    "pointer",
    "key",
    "scroll",
    "drag",
    "move",
    "frontmost",
    "readiness",
    "monitor",
    "input-overflow",
    "unresolved",
    "activation",
    "permit-expired",
  ])("decodes typed cause %s", (cause) => {
    expect(Schema.decodeUnknownSync(ComputerInterruptionCause)(cause)).toBe(cause);
  });
  it("retains pre-write interruption evidence and validates native availability epochs", () => {
    const error = { _tag: "Interrupted", cause: "user-input", actionStarted: false };
    expect(Schema.decodeUnknownSync(ComputerAutomationError)(error)).toEqual(error);
    const ready = {
      activityEpoch: 3,
      lastActivityAgeMs: 1500,
      frontmost: false,
      monitorHealthy: true,
      inputSequence: 5,
      lastUserInputAgeMs: -1,
      inputHeld: false,
    };
    expect(Schema.decodeUnknownSync(ComputerTargetReadiness)(ready)).toEqual(ready);
    expect(() =>
      Schema.decodeUnknownSync(ComputerTargetReadiness)({ ...ready, activityEpoch: -1 }),
    ).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(ComputerTargetReadiness)({ ...ready, inputHeld: undefined }),
    ).toThrow();
  });
  it("decodes foreground and background yield events and rejects invalid wait durations", () => {
    for (const message of [
      { type: "targetYielded", threadId: "t", sessionGeneration: "s" },
      { type: "targetYielded", threadId: "t", sessionGeneration: "s", appId: "app" },
      { type: "computerTurnEnded", threadId: "t", sessionGeneration: "s", turnId: "turn" },
    ])
      expect(Schema.decodeUnknownSync(DesktopComputerHostMessage)(message)).toEqual(message);
    const holder = {
      profileId: "p",
      threadId: "t",
      sessionGeneration: "s",
      turnId: "turn",
      executionGeneration: 1,
      grantVersion: 1,
      grants: [],
      backend: "native",
      threadTitle: "Thread",
      scope: { kind: "foreground" },
      policyRevision: 0,
    };
    for (const timeoutMs of [100, 30_000])
      expect(
        Schema.decodeUnknownSync(DesktopComputerHostMessage)({
          type: "targetWait",
          requestId: "wait",
          holder,
          timeoutMs,
        }),
      ).toMatchObject({ timeoutMs });
    for (const timeoutMs of [99, 30_001, 100.5])
      expect(() =>
        Schema.decodeUnknownSync(DesktopComputerHostMessage)({
          type: "targetWait",
          requestId: "wait",
          holder,
          timeoutMs,
        }),
      ).toThrow();
    expect(
      Schema.decodeUnknownSync(DesktopComputerHostMessage)({
        type: "leaseAcquire",
        requestId: "acquire",
        holder,
        cooperative: true,
        waitMs: 20_000,
      }),
    ).toMatchObject({ cooperative: true, waitMs: 20_000 });
    for (const waitMs of [-1, 20_001, 1.5])
      expect(() =>
        Schema.decodeUnknownSync(DesktopComputerHostMessage)({
          type: "leaseAcquire",
          requestId: "acquire",
          holder,
          waitMs,
        }),
      ).toThrow();
    const reserved = { type: "takeoverReserved", requestId: "reservation" };
    expect(Schema.decodeUnknownSync(DesktopComputerHostMessage)(reserved)).toEqual(reserved);
  });
  it("decodes session-close messages and rejects noncanonical typing policy", () => {
    const closed = { type: "computerSessionClosed", threadId: "t", sessionGeneration: "s" };
    expect(Schema.decodeUnknownSync(DesktopComputerHostMessage)(closed)).toEqual(closed);
    const policy = {
      version: 1,
      kind: "app-access",
      projectId: "p",
      appId: "app",
      tier: "full",
      allowTyping: false,
      policyVersion: 1,
    };
    expect(Schema.decodeUnknownSync(RememberedComputerConsent)(policy)).toEqual(policy);
    expect(() =>
      Schema.decodeUnknownSync(RememberedComputerConsent)({
        ...policy,
        allowTyping: true,
      }),
    ).toThrow();
  });
  it("accepts optional request policy and supported-helper status without changing legacy data", () => {
    const request = {
      op: "screenshot",
      requestId: "r",
      payloadHash: "0".repeat(64),
      authorization: {
        profileId: "p",
        threadId: "t",
        sessionGeneration: "s",
        turnId: "turn",
        executionGeneration: 1,
        grantVersion: 0,
        grants: [],
      },
      deadlineAtMs: 1,
      agent: { provider: "claude", threadTitle: "Thread" },
      displayId: "d",
    };
    expect(Schema.decodeUnknownSync(ComputerAutomationRequest)(request)).toEqual(request);
    for (const passwordMasking of ["fast", "conservative"]) {
      expect(
        Schema.decodeUnknownSync(ComputerAutomationRequest)({ ...request, passwordMasking }),
      ).toEqual({ ...request, passwordMasking });
    }
    expect(() =>
      Schema.decodeUnknownSync(ComputerAutomationRequest)({
        ...request,
        passwordMasking: "off",
      }),
    ).toThrow();
    for (const status of [
      { available: true },
      { available: true, passwordMaskingSupported: true },
      { available: true, hostPlatform: "win32", stopShortcut: "Ctrl+Alt+Shift+F12" },
      {
        available: false,
        reason: "monitor-unhealthy",
        hostPlatform: "win32",
        stopShortcut: "Ctrl+Alt+Shift+F12",
      },
    ]) {
      expect(Schema.decodeUnknownSync(ComputerAutomationBackendStatus)(status)).toEqual(status);
    }
  });
  it("decodes partial inspect snapshots", () => {
    const value = { snapshotId: "s", appId: "a", accessible: true, truncated: true, nodes: [] };
    expect(Schema.decodeUnknownSync(ComputerInspectResult)(value)).toEqual(value);
  });
  it("decodes screenshot mask scope and reasons", () => {
    const value = {
      displayId: "d",
      geometryGeneration: "g",
      modelSize: { width: 100, height: 100 },
      mimeType: "image/jpeg",
      data: "",
      hiddenContent: true,
      passwordMasking: "fast",
      masked: "web-area",
      maskReasons: ["partial-audit", "window-match", "audit-incomplete", "windows-changed"],
      secureAudit: {
        searchEnabled: true,
        elapsedMs: 1000,
        windows: [
          {
            windowIndex: 0,
            complete: false,
            elapsedMs: 1000,
            visitedNodes: 98,
            nodeReadElapsedMs: 990,
            maxChildren: 50050,
            textFieldQueries: 1,
            frameQueries: 0,
            searchResults: 0,
            searchElapsedMs: 5,
            searchFallbacks: 1,
            invalidSearchResults: 0,
            stopReasons: ["deadline"],
            axFailures: [{ operation: "text-fields", error: -25205, count: 1 }],
          },
        ],
      },
    };
    expect(Schema.decodeUnknownSync(ComputerScreenshot)(value)).toEqual(value);
    const { secureAudit: _, passwordMasking: _mode, ...legacy } = value;
    expect(Schema.decodeUnknownSync(ComputerScreenshot)(legacy)).toEqual(legacy);
    expect(
      Schema.decodeUnknownSync(ComputerScreenshot)({
        ...value,
        passwordMasking: "conservative",
      }).passwordMasking,
    ).toBe("conservative");
    expect(() =>
      Schema.decodeUnknownSync(ComputerScreenshot)({
        ...value,
        passwordMasking: "off",
      }),
    ).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(ComputerScreenshot)({
        ...value,
        secureAudit: { ...value.secureAudit, elapsedMs: -1 },
      }),
    ).toThrow();
  });
  it("accepts stale refs from legacy helpers and detailed macOS reasons", () => {
    for (const reason of [
      undefined,
      "snapshot-expired",
      "window-changed",
      "element-gone",
      "role-changed",
    ]) {
      const value = { _tag: "StaleElement", ...(reason ? { reason } : {}) };
      expect(Schema.decodeUnknownSync(ComputerAutomationError)(value)).toEqual(value);
    }
    expect(() =>
      Schema.decodeUnknownSync(ComputerAutomationError)({
        _tag: "StaleElement",
        reason: "unexpected",
      }),
    ).toThrow();
  });
});
