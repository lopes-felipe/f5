import { expect, it } from "vitest";
import type { ComputerAutomationRequest } from "@t3tools/contracts";
import { MCP_DIAGNOSTIC_PREFIX } from "./rehearsalMcpTransport";
import {
  ElectronRehearsalObservation,
  rehearsalProviderErrorCodes,
  rehearsalProviderActivityCounts,
  rehearsalSessionErrorCode,
  rehearsalHarnessFailureCode,
  rehearsalHarnessFailureLocation,
} from "./rehearsalElectronObservation";

it("retains allowlisted source coordinates without error contents or private paths", () => {
  const error = new TypeError("PRIVATE_SENTINEL");
  error.stack = [
    "TypeError: PRIVATE_SENTINEL",
    "    at privateFunction (file:///PRIVATE_HOME/rehearse-computer-profile-isolation.mjs:421:17)",
    "    at privateFunction (file:///PRIVATE_HOME/rehearsalProfileIsolation.ts:24:5)",
    "    at privateFunction (file:///PRIVATE_HOME/untrusted.ts:24:5)",
    "    at privateFunction (file:///PRIVATE_HOME/rehearsalProfileIsolation.ts:999999:5)",
  ].join("\n");
  const result = rehearsalHarnessFailureLocation(error);
  expect(result).toEqual({
    kind: "TypeError",
    frames: [
      { source: "rehearse-computer-profile-isolation.mjs", line: 421, column: 17 },
      { source: "rehearsalProfileIsolation.ts", line: 24, column: 5 },
    ],
  });
  expect(JSON.stringify(result)).not.toMatch(/PRIVATE|privateFunction|untrusted/);
  error.name = "PRIVATE_SENTINEL";
  error.stack =
    "    at privateFunction (file:///PRIVATE_HOME/rehearsalProfileIsolation.ts:1:1)\n".repeat(10);
  expect(rehearsalHarnessFailureLocation(error).kind).toBe("unknown");
  expect(rehearsalHarnessFailureLocation(error).frames).toHaveLength(4);
  expect(rehearsalHarnessFailureLocation({ message: "PRIVATE" })).toEqual({
    kind: "unknown",
    frames: [],
  });
});

it("keeps expanded profile polling observations bounded without retaining native payloads", () => {
  for (const limit of [128, 1024, 2048]) {
    const observer = new ElectronRehearsalObservation(limit);
    for (let i = 0; i <= limit; i++) {
      observer.receive({
        type: "leaseAcquire",
        requestId: `request-${i}`,
        holder: {
          profileId: "profile",
          threadId: "thread",
          sessionGeneration: "session",
          turnId: "turn",
          executionGeneration: 1,
          grantVersion: 1,
          grants: [],
          backend: "native",
          threadTitle: "PRIVATE_SENTINEL",
        },
      });
      observer.receive({ type: "response", requestId: `request-${i}`, result: true });
      if (i === limit - 1) expect(observer.snapshot().traceComplete).toBe(true);
    }
    const result = observer.snapshot();
    expect(result.operations).toHaveLength(limit);
    expect(result.traceComplete).toBe(false);
    expect(JSON.stringify(result)).not.toContain("PRIVATE_SENTINEL");
  }
  for (const invalid of [0, 127, 2049, Infinity, 128.5])
    expect(() => new ElectronRehearsalObservation(invalid)).toThrow(
      "Invalid rehearsal observation limit.",
    );
});

it("validates bounded transport diagnostics and discards extra private fields", () => {
  const receipt = {
    method: "tools/call",
    sessionHeader: true,
    status: 404,
    bounded: true,
    requestDecoded: true,
    responseDecoded: true,
    outcome: "expired-session",
    completed: true,
    secret: "PRIVATE_SENTINEL",
  };
  const observer = new ElectronRehearsalObservation();
  observer.backendLog(MCP_DIAGNOSTIC_PREFIX.slice(0, 8));
  observer.backendLog(MCP_DIAGNOSTIC_PREFIX.slice(8) + JSON.stringify(receipt) + "\n");
  expect(observer.snapshot().mcpTransport).toHaveLength(1);
  expect(observer.snapshot().mcpTransport[0]?.outcome).toBe("expired-session");
  expect(JSON.stringify(observer.snapshot())).not.toContain("PRIVATE_SENTINEL");
  observer.backendLog(
    MCP_DIAGNOSTIC_PREFIX + JSON.stringify({ ...receipt, outcome: "PRIVATE_SENTINEL" }) + "\n",
  );
  expect(observer.snapshot().mcpTransport).toHaveLength(1);
  expect(observer.snapshot().mcpTransportOverflow).toBe(true);
  for (let i = 0; i < 130; i++)
    observer.backendLog(MCP_DIAGNOSTIC_PREFIX + JSON.stringify(receipt) + "\n");
  expect(observer.snapshot().mcpTransport).toHaveLength(128);
});

it("keeps provider tool and approval diagnostics bounded and content-free", () => {
  const events = [
    "tool.started",
    "tool.completed",
    "approval.requested",
    "approval.resolved",
    "user-input.requested",
    "user-input.resolved",
    "__proto__",
  ].map((kind) => ({
    kind,
    turnId: "PRIVATE_TURN",
    summary: "PRIVATE_SUMMARY",
    payload: { status: "declined", text: "PRIVATE_VALUE", error: "PRIVATE_ERROR" },
  }));
  const summary = rehearsalProviderActivityCounts(events);
  expect(summary).toMatchObject({
    observed: true,
    boundedOrMalformed: false,
    turns: [
      {
        turnOrdinal: 1,
        toolStarted: 1,
        toolCompleted: 1,
        toolDeclined: 1,
        toolFailed: 0,
        approvalsRequested: 1,
        approvalsResolved: 1,
        userInputsRequested: 1,
        userInputsResolved: 1,
        other: 1,
      },
    ],
  });
  expect(JSON.stringify(summary)).not.toContain("PRIVATE");
  expect(rehearsalProviderActivityCounts(undefined).observed).toBe(false);
  expect(rehearsalProviderActivityCounts([null, {}]).boundedOrMalformed).toBe(true);
  expect(rehearsalProviderActivityCounts(Array(101).fill(events[0])).boundedOrMalformed).toBe(true);
  const manyTurns = Array.from({ length: 20 }, (_, index) => ({
    ...events[0],
    turnId: String(index),
  }));
  expect(rehearsalProviderActivityCounts(manyTurns).turns).toHaveLength(16);
  expect(rehearsalProviderActivityCounts(manyTurns).boundedOrMalformed).toBe(true);
});

it("distinguishes recorded provider approval decisions without keeping arbitrary values", () => {
  const summary = rehearsalProviderActivityCounts(
    [
      "accept",
      "acceptForSession",
      "acceptAlways",
      "decline",
      "cancel",
      "PRIVATE_DECISION",
      undefined,
    ].map((decision) => ({
      kind: "approval.resolved",
      turnId: "PRIVATE_TURN",
      payload: { decision, detail: "PRIVATE_CONTENT" },
    })),
  );
  expect(summary.turns[0]).toMatchObject({
    approvalsResolved: 7,
    approvalsAccepted: 3,
    approvalsDeclined: 1,
    approvalsCancelled: 1,
    approvalsUnknown: 2,
  });
  expect(JSON.stringify(summary)).not.toContain("PRIVATE");
});

it("keeps harness failure diagnostics content-free", () => {
  for (const [message, code] of [
    [
      "electronApplication.evaluate: Cannot serialize result: object reference chain is too long.",
      "electron-serialization",
    ],
    ["electronApplication.evaluate: Execution context was destroyed", "electron-context-lost"],
    [
      "electronApplication.evaluate: Target page, context or browser has been closed",
      "electron-target-closed",
    ],
    ["electronApplication.evaluate: PRIVATE_SENTINEL", "electron-evaluation"],
  ]) {
    const result = rehearsalHarnessFailureCode(new Error(`${message} PRIVATE_CONTENT`));
    expect(result).toBe(code);
    expect(result).not.toContain("PRIVATE");
  }
  expect(rehearsalHarnessFailureCode(new Error("External rehearsal transport Unavailable"))).toBe(
    "external-transport-unavailable",
  );
  expect(rehearsalHarnessFailureCode(new Error("External rehearsal transport Interrupted"))).toBe(
    "external-transport-interrupted",
  );
  expect(
    rehearsalHarnessFailureCode(new Error("External rehearsal transport OutcomeUnknown")),
  ).toBe("external-transport-outcome-unknown");
  expect(
    rehearsalHarnessFailureCode(
      new Error("External rehearsal transport Unavailable PRIVATE_SENTINEL"),
    ),
  ).toBe("unknown");
  expect(rehearsalHarnessFailureCode(new Error("strict mode violation: PRIVATE_SENTINEL"))).toBe(
    "ambiguous-locator",
  );
  expect(rehearsalHarnessFailureCode(new Error("PRIVATE_SENTINEL timed out"))).toBe("timeout");
  expect(rehearsalHarnessFailureCode(new Error("Unexpected certification consent request."))).toBe(
    "unexpected-consent",
  );
  expect(rehearsalHarnessFailureCode(new Error("Unexpected certification consent answer."))).toBe(
    "unexpected-consent-answer",
  );
  expect(
    rehearsalHarnessFailureCode(new Error("Physical input interrupted the active turn.")),
  ).toBe("physical-input");
  expect(rehearsalHarnessFailureCode(new Error("Provider turn did not complete."))).toBe(
    "provider-turn-incomplete",
  );
  expect(
    rehearsalHarnessFailureCode(new Error("Isolation owner turn ended without a lease.")),
  ).toBe("owner-ended-without-lease");
  expect(
    rehearsalHarnessFailureCode(new Error("Isolation owner turn ended without a lease. PRIVATE")),
  ).toBe("unknown");
  expect(rehearsalHarnessFailureCode(new Error("Session actions receipt incomplete."))).toBe(
    "incomplete-receipt",
  );
  expect(rehearsalHarnessFailureCode(new Error("PRIVATE_SENTINEL"))).toBe("unknown");
  expect(rehearsalHarnessFailureCode("PRIVATE_SENTINEL")).toBe("unknown");
});

it("extracts restart flags from split backend logs without retaining messages or identities", () => {
  const observer = new ElectronRehearsalObservation();
  observer.backendLog("PRIVATE_SENTINEL ordinary log\nprovider command reactor rest");
  observer.backendLog(
    "arting provider session\n  threadId: PRIVATE_SENTINEL\n  shouldRestartForModelOptionsChange: true\n  shouldRestartForComputerUseChange: false\n",
  );
  observer.backendLog('  "runtimeModeChanged": true,\n  unknownFlag: true\n');
  observer.backendLog(
    "provider launch identity changed; replacing active session PRIVATE_SENTINEL\n",
  );
  observer.backendLog(
    "provider service resumed provider session from persisted binding PRIVATE_SENTINEL\n",
  );
  expect(observer.snapshot().backendRestarts).toEqual([
    { reasons: ["model-options-changed", "runtime-mode-changed"] },
  ]);
  expect(JSON.stringify(observer.snapshot())).not.toContain("PRIVATE_SENTINEL");
  expect(observer.snapshot().backendLifecycle).toEqual([
    "launch-identity-changed",
    "persisted-session-resumed",
  ]);
});

it("reports opaque session ordinals for native requests", () => {
  const observer = new ElectronRehearsalObservation();
  for (const [index, session] of ["PRIVATE_ONE", "PRIVATE_ONE", "PRIVATE_TWO"].entries()) {
    const req = request("listApps", String(index));
    observer.receive({
      type: "request",
      request: { ...req, authorization: { ...req.authorization, sessionGeneration: session } },
    });
  }
  expect(observer.snapshot().requestSessions).toEqual(
    [1, 1, 2].map((sessionOrdinal) => ({ op: "listApps", sessionOrdinal })),
  );
  expect(JSON.stringify(observer.snapshot())).not.toContain("PRIVATE_");
});

const request = (
  op: "screenshot" | "inspect" | "type" | "listApps" | "activateApp",
  requestId: string = op,
) =>
  ({
    requestId,
    payloadHash: "a".repeat(64),
    deadlineAtMs: Date.now() + 30000,
    authorization: {
      profileId: "profile",
      threadId: "thread",
      sessionGeneration: "session",
      turnId: "turn",
      executionGeneration: 1,
      grantVersion: 1,
      grants: [],
    },
    agent: { provider: "codex", threadTitle: "PRIVATE_SENTINEL" },
    op,
    appId: "fixture",
    maxNodes: 25,
    text: "PRIVATE_SENTINEL",
  }) as ComputerAutomationRequest;
const screenshot = {
  displayId: "display",
  geometryGeneration: "geometry",
  modelSize: { width: 100, height: 100 },
  mimeType: "image/png",
  data: "PRIVATE_SENTINEL",
  hiddenContent: true,
};
it("requires correlated background delivery to the requested app and omits private identities", () => {
  for (const [delivery, target, frontmost, delivered] of [
    ["background", "PRIVATE_APP", "other", true],
    ["foreground", "PRIVATE_APP", "other", false],
    ["background", "wrong-app", "other", false],
    ["background", "PRIVATE_APP", "PRIVATE_APP", true],
  ] as const) {
    const observer = new ElectronRehearsalObservation();
    observer.receive({
      type: "request",
      request: {
        ...request("type", "background"),
        op: "elementAction",
        appId: "PRIVATE_APP",
        delivery: "background",
        snapshotId: "snapshot",
        elementRef: "element",
        action: "setValue",
        value: "PRIVATE_TEXT",
      },
    });
    observer.receive({
      type: "response",
      requestId: "background",
      result: {
        displayId: "display",
        geometryGeneration: "geometry",
        cursor: null,
        actionCompleted: true,
        frontmostApp: {
          appId: frontmost,
          name: "PRIVATE_TITLE",
          running: true,
          frontmost: true,
          tier: "full",
        },
        delivery,
        target: { appId: target },
      },
    });
    expect(observer.snapshot().operations).toEqual([
      {
        op: "elementAction",
        action: "setValue",
        outcome: "ok",
        backgroundDelivery: delivered,
      },
    ]);
    expect(JSON.stringify(observer.snapshot())).not.toContain("PRIVATE");
  }
});

it("counts IPC activity and action captures without retaining thumbnails or screenshot errors", () => {
  const observer = new ElectronRehearsalObservation();
  observer.receive({
    type: "activity",
    activity: {
      threadId: "PRIVATE_SENTINEL",
      backend: "native",
      op: "activateApp",
      status: "completed",
      outcome: "app-resolution-failed",
      appName: "PRIVATE_SENTINEL",
      thumbnailDataUrl: "PRIVATE_SENTINEL",
    },
  });
  for (const [id, error] of [
    ["known", "missing-permissions"],
    ["private", "PRIVATE_SENTINEL"],
    ["tag", "Unavailable"],
  ]) {
    observer.receive({ type: "request", request: request("activateApp", id) });
    observer.receive({
      type: "response",
      requestId: id,
      result: {
        actionCompleted: true,
        screenshot,
        screenshotError: error,
      },
    });
  }
  const snapshot = observer.snapshot();
  expect(snapshot.activityMessages).toBe(1);
  expect(snapshot.activityThumbnails).toBe(1);
  expect(snapshot.toolOutcomeErrors).toEqual(["app-resolution-failed"]);
  expect(snapshot.operations).toEqual([
    { op: "activateApp", outcome: "ok", actionCompleted: true, actionCaptureSucceeded: true },
    { op: "activateApp", outcome: "ok", actionCompleted: true, actionCaptureSucceeded: true },
    {
      op: "activateApp",
      outcome: "ok",
      actionCompleted: true,
      actionCaptureSucceeded: true,
      screenshotError: "Unavailable",
    },
  ]);
  expect(JSON.stringify(snapshot)).not.toContain("PRIVATE_SENTINEL");
});

it("classifies fixed F5 execution failures without retaining arbitrary error detail", () => {
  const observer = new ElectronRehearsalObservation();
  for (const [id, message] of [
    ["timeout", "Accessibility observation timed out."],
    ["private", "PRIVATE_SENTINEL"],
    ["lookalike", "Accessibility observation timed out. PRIVATE_SENTINEL"],
  ]) {
    observer.receive({ type: "request", request: request("inspect", id) });
    observer.receive({ type: "response", requestId: id, error: { _tag: "Execution", message } });
  }
  expect(observer.snapshot().operations).toEqual([
    { op: "inspect", outcome: "Execution", executionCode: "accessibility-timeout" },
    { op: "inspect", outcome: "Execution" },
    { op: "inspect", outcome: "Execution" },
  ]);
  expect(JSON.stringify(observer.snapshot())).not.toContain("PRIVATE_SENTINEL");
});

it("validates metadata responses and omits app identities from the diagnostic", () => {
  const observer = new ElectronRehearsalObservation();
  observer.receive({ type: "request", request: request("listApps") });
  observer.receive({
    type: "response",
    requestId: "listApps",
    result: [
      {
        appId: "PRIVATE_SENTINEL",
        name: "PRIVATE_SENTINEL",
        running: true,
        frontmost: false,
        tier: "full",
      },
    ],
  });
  observer.receive({ type: "request", request: request("listApps", "bad-apps") });
  observer.receive({ type: "response", requestId: "bad-apps", result: { ok: true } });
  expect(observer.snapshot().operations).toEqual([
    { op: "listApps", outcome: "ok", validApps: true },
    { op: "listApps", outcome: "invalid-apps", validApps: false },
  ]);
  expect(JSON.stringify(observer.snapshot())).not.toContain("PRIVATE_SENTINEL");
});

it("retains only known host status reasons and pre-host provider error codes", () => {
  const observer = new ElectronRehearsalObservation();
  observer.receive({
    type: "status",
    status: { available: false, reason: "monitor-unhealthy", detail: "PRIVATE_SENTINEL" },
  });
  expect(observer.snapshot().hostStatus).toEqual({ available: false, reason: "monitor-unhealthy" });
  expect(JSON.stringify(observer.snapshot())).not.toContain("PRIVATE_SENTINEL");
  expect(
    rehearsalProviderErrorCodes([
      { payload: { result: { error: { _tag: "ReplayRejected", detail: "PRIVATE_SENTINEL" } } } },
      { _tag: "PRIVATE_SENTINEL" },
    ]),
  ).toEqual(["ReplayRejected"]);
});
it("reduces session failures to fixed categories without retaining their contents", () => {
  const examples = [
    ["usage limit reached PRIVATE_SENTINEL", "usage-limit"],
    ["provider unavailable PRIVATE_SENTINEL", "provider-unavailable"],
    ["unsupported-isolation: PRIVATE_SENTINEL", "profile-isolation"],
    ["delivery guard rejected PRIVATE_SENTINEL", "context-guard"],
    ["Failed to launch executable PRIVATE_SENTINEL", "cli-launch"],
    ["authentication required PRIVATE_SENTINEL", "authentication"],
    ["unknown model PRIVATE_SENTINEL", "model-unavailable"],
    ["SDK MCP server failed PRIVATE_SENTINEL", "mcp"],
    ["PRIVATE_SENTINEL", "unknown"],
  ];
  for (const [message, expected] of examples) {
    const code = rehearsalSessionErrorCode(message);
    expect(code).toBe(expected);
    expect(code).not.toContain("PRIVATE_SENTINEL");
  }
  for (const value of [null, undefined, {}, " "])
    expect(rehearsalSessionErrorCode(value)).toBe("none");
  expect(rehearsalSessionErrorCode("x".repeat(8192) + "unknown model")).toBe("unknown");
});

it("records correlated outcome codes without input, images, accessibility values or error details", () => {
  const observer = new ElectronRehearsalObservation();
  for (const op of ["type", "inspect", "screenshot"] as const)
    observer.receive({ type: "request", request: request(op) });
  observer.receive({
    type: "response",
    requestId: "type",
    error: { _tag: "Execution", message: "PRIVATE_SENTINEL" },
  });
  observer.receive({
    type: "response",
    requestId: "inspect",
    result: {
      snapshotId: "snapshot",
      appId: "fixture",
      accessible: true,
      nodes: [
        {
          elementRef: "element",
          role: "AXTextField",
          name: "PRIVATE_SENTINEL",
          value: "PRIVATE_SENTINEL",
          enabled: true,
          focused: true,
          actions: [],
        },
      ],
    },
  });
  observer.receive({ type: "response", requestId: "screenshot", result: screenshot });
  const summary = observer.snapshot();
  expect(summary.operations).toEqual([
    { op: "type", outcome: "Execution" },
    { op: "inspect", outcome: "ok", accessible: true, nodes: 1 },
    { op: "screenshot", outcome: "ok", validCapture: true },
  ]);
  expect(JSON.stringify(summary)).not.toContain("PRIVATE_SENTINEL");
  expect(summary.captureResponses).toBe(1);
  expect(summary.responses.nativeInputSucceeded).toBe(false);
});
it("ignores uncorrelated and repeated terminal responses, including retried IDs", () => {
  const observer = new ElectronRehearsalObservation();
  observer.receive({ type: "response", requestId: "screenshot", result: screenshot });
  observer.receive({ type: "request", request: request("screenshot") });
  observer.receive({ type: "response", requestId: "screenshot", result: screenshot });
  observer.receive({ type: "request", request: request("screenshot") });
  observer.receive({ type: "response", requestId: "screenshot", result: screenshot });
  expect(observer.snapshot().captureResponses).toBe(1);
  expect(observer.snapshot().operations).toHaveLength(1);
});
it("keeps only typed interruption/protection codes and bounds the trace", () => {
  const observer = new ElectronRehearsalObservation();
  observer.receive({ type: "request", request: request("type") });
  observer.receive({
    type: "response",
    requestId: "type",
    error: { _tag: "Interrupted", cause: "user-input" },
  });
  expect(observer.snapshot().operations[0]).toEqual({
    op: "type",
    outcome: "Interrupted",
    cause: "user-input",
  });
  for (let index = 0; index < 129; index++)
    observer.receive({ type: "request", request: request("screenshot", `capture-${index}`) });
  expect(observer.snapshot().traceComplete).toBe(false);
  observer.receive({ type: "request", request: { op: "INVALID_PRIVATE_SENTINEL" } });
  expect(JSON.stringify(observer.snapshot())).not.toContain("INVALID_PRIVATE_SENTINEL");
});
it("accepts a retryable background yield as the interruption outcome", () => {
  const observer = new ElectronRehearsalObservation();
  observer.receive({
    type: "request",
    request: {
      ...request("type"),
      delivery: "background",
      appId: "app",
    },
  });
  observer.receive({
    type: "response",
    requestId: "type",
    error: { _tag: "TargetBlocked", kind: "user-active" },
  });
  expect(observer.snapshot().operations[0]).toEqual({
    op: "type",
    outcome: "TargetBlocked",
    kind: "user-active",
  });
});

it("distinguishes requested consent from correlated host-forwarded answers without retaining decisions", () => {
  const observer = new ElectronRehearsalObservation();
  const answer = {
    requestId: "access",
    backendIncarnation: "backend",
    decisions: [{ appId: "PRIVATE_SENTINEL", allow: true, allowTyping: false, remember: false }],
  };
  observer.receive({ type: "accessAnswer", answer });
  expect(observer.snapshot().accessAnswersForwarded).toBe(0);
  observer.receive({
    type: "accessRequested",
    request: {
      requestId: "access",
      threadId: "thread",
      reason: "PRIVATE_SENTINEL",
      kind: "apps",
      apps: [{ appId: "PRIVATE_SENTINEL", name: "PRIVATE_SENTINEL", tier: "full" }],
    },
  });
  observer.receive({ type: "accessAnswer", answer });
  observer.receive({ type: "accessAnswer", answer });
  expect(observer.snapshot().accessRequests).toBe(1);
  expect(observer.snapshot().accessAnswersForwarded).toBe(1);
  expect(JSON.stringify(observer.snapshot())).not.toContain("PRIVATE_SENTINEL");
});

it("records lease admission failures separately from native action responses", () => {
  const observer = new ElectronRehearsalObservation();
  observer.receive({
    type: "leaseAcquire",
    requestId: "lease",
    holder: {
      profileId: "profile",
      threadId: "thread",
      sessionGeneration: "session",
      turnId: "turn",
      executionGeneration: 1,
      grantVersion: 1,
      grants: [],
      backend: "native",
      threadTitle: "PRIVATE_SENTINEL",
    },
  });
  observer.receive({
    type: "response",
    requestId: "lease",
    error: { _tag: "Interrupted", cause: "user-input" },
  });
  expect(observer.snapshot().operations).toEqual([
    { op: "leaseAcquire", outcome: "Interrupted", cause: "user-input" },
  ]);
  expect(observer.snapshot().responses.nativeInputSucceeded).toBe(false);
  expect(JSON.stringify(observer.snapshot())).not.toContain("PRIVATE_SENTINEL");
});

it("distinguishes session-actions approval from app consent without retaining content", () => {
  const observer = new ElectronRehearsalObservation();
  for (const allow of [false, true]) {
    const requestId = String(allow);
    observer.receive({
      type: "accessRequested",
      request: {
        requestId,
        threadId: "PRIVATE_SENTINEL",
        reason: "PRIVATE_SENTINEL",
        kind: "session-actions",
        apps: [],
      },
    });
    observer.receive({
      type: "accessAnswer",
      answer: {
        requestId,
        backendIncarnation: "PRIVATE_SENTINEL",
        decisions: [],
        allowSessionActions: allow,
      },
    });
  }
  expect(observer.snapshot().accessAnswerSummaries).toEqual(
    [false, true].map((allowSessionActions) => ({
      kind: "session-actions",
      appCount: 0,
      allowed: 0,
      remembered: 0,
      allowSessionActions,
    })),
  );
  expect(JSON.stringify(observer.snapshot())).not.toContain("PRIVATE_SENTINEL");
});

it("correlates semantic action enums and retains missing responses without retaining values", () => {
  const observer = new ElectronRehearsalObservation();
  for (const action of ["press", "focus", "setValue"] as const) {
    observer.receive({
      type: "request",
      request: {
        ...request("type", action),
        op: "elementAction",
        appId: "fixture",
        snapshotId: "snapshot",
        elementRef: "element",
        action,
        value: "PRIVATE_SENTINEL",
      },
    });
  }
  expect(observer.snapshot().pendingResponses).toBe(3);
  for (const action of ["press", "focus"])
    observer.receive({
      type: "response",
      requestId: action,
      result: {
        displayId: "display",
        geometryGeneration: "geometry",
        frontmostApp: null,
        cursor: null,
      },
    });
  expect(observer.snapshot().operations).toEqual([
    { op: "elementAction", outcome: "ok", action: "press" },
    { op: "elementAction", outcome: "ok", action: "focus" },
  ]);
  expect(observer.snapshot().pendingResponses).toBe(1);
  expect(JSON.stringify(observer.snapshot())).not.toContain("PRIVATE_SENTINEL");
});

it("rejects malformed or explicitly uncompleted native action receipts", () => {
  const observer = new ElectronRehearsalObservation();
  for (const [id, result] of [
    ["malformed", {}],
    [
      "uncompleted",
      {
        displayId: "display",
        geometryGeneration: "geometry",
        frontmostApp: null,
        cursor: null,
        actionCompleted: false,
      },
    ],
  ] as const) {
    observer.receive({ type: "request", request: request("type", id) });
    observer.receive({ type: "response", requestId: id, result });
  }
  expect(observer.snapshot().operations.map((op) => op.outcome)).toEqual([
    "invalid-action",
    "invalid-action",
  ]);
  expect(observer.snapshot().pendingResponses).toBe(0);
});

it("counts session and grant changes without retaining grant or session identities", () => {
  const observer = new ElectronRehearsalObservation();
  for (const id of ["PRIVATE_SESSION_ONE", "PRIVATE_SESSION_TWO"]) {
    const req = request("listApps", id);
    const authorization = {
      ...req.authorization,
      sessionGeneration: id,
      grants: id.endsWith("ONE")
        ? [{ appId: "PRIVATE_APP", tier: "full" as const, allowTyping: false }]
        : [],
    };
    observer.receive({ type: "request", request: { ...req, authorization } });
    observer.receive({ type: "response", requestId: id, result: [] });
    observer.receive({ type: "grantsChanged", authorization });
  }
  expect(observer.snapshot()).toMatchObject({
    sessionGenerationsObserved: 2,
    grantChanges: 2,
    lastGrantCount: 0,
  });
  expect(JSON.stringify(observer.snapshot())).not.toContain("PRIVATE_");
});
