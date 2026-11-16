import { expect, it } from "vitest";
import type { ComputerAutomationRequest } from "@t3tools/contracts";
import {
  RehearsalRealAppsObservation,
  REAL_APP_REHEARSAL_IDS,
  REAL_APP_REHEARSAL_TEXT,
} from "./rehearsalRealAppsObservation";
const [textEdit, calculator] = REAL_APP_REHEARSAL_IDS;
const request = (
  op: "inspect" | "type" | "key" | "openApp" | "elementAction",
  appId: string = calculator,
  requestId: string = op,
  threadId = "thread",
) => ({
  type: "request",
  request: {
    op,
    appId,
    requestId,
    authorization: {
      profileId: "profile",
      threadId,
      sessionGeneration: "session",
      turnId: "turn",
      executionGeneration: 1,
      grantVersion: 1,
      grants: [],
    },
    payloadHash: "a".repeat(64),
    deadlineAtMs: Date.now() + 10000,
    agent: { provider: "codex", threadTitle: "PRIVATE_SENTINEL" },
    text: "PRIVATE_SENTINEL",
    chords: ["PRIVATE_SENTINEL"],
    repeat: 1,
    maxNodes: 100,
    snapshotId: "snapshot",
    elementRef: "element",
    action: "press",
  } as ComputerAutomationRequest,
});
const action = (appId: string, actionCompleted = true) => ({
  displayId: "display",
  geometryGeneration: "geometry",
  cursor: null,
  actionCompleted,
  frontmostApp: { appId, name: "PRIVATE_SENTINEL", running: true, frontmost: true, tier: "full" },
});
const inspection = (appId: string) => ({
  snapshotId: "snapshot",
  appId,
  accessible: true,
  nodes: [
    {
      elementRef: "element",
      role: "AXTextField",
      name: "PRIVATE_SENTINEL",
      value: "PRIVATE_SENTINEL",
      focused: true,
      enabled: true,
      actions: [],
    },
  ],
});
it("requires correlated successful results for the expected app and keeps only safe evidence", () => {
  const trace = new RehearsalRealAppsObservation("thread");
  for (const [op, appId] of [
    ["inspect", textEdit],
    ["inspect", calculator],
    ["type", textEdit],
    ["key", textEdit],
    ["openApp", calculator],
    ["elementAction", calculator],
  ] as const) {
    const id = op + appId;
    trace.receive(request(op, appId, id));
    trace.receive({
      type: "response",
      requestId: id,
      result: op === "inspect" ? inspection(appId) : action(appId),
    });
  }
  expect(trace.snapshot()).toEqual({
    textEditInspected: true,
    calculatorInspected: true,
    textEditTyping: true,
    textEditKeys: 1,
    expectedTextTyping: false,
    selectAllKeySucceeded: false,
    saveKeySucceeded: false,
    calculatorOpened: true,
    calculatorPresses: 1,
    unexpectedAppInput: false,
    failedMutations: 0,
    ambiguousMutations: 0,
    observationFailures: 0,
    typingRequests: 1,
    traceComplete: true,
  });
  expect(JSON.stringify(trace.snapshot())).not.toContain("PRIVATE_SENTINEL");
});
it("does not credit mismatched app results, incomplete actions or another thread", () => {
  const trace = new RehearsalRealAppsObservation("thread");
  trace.receive(request("inspect", textEdit));
  trace.receive({ type: "response", requestId: "inspect", result: inspection(calculator) });
  trace.receive(request("openApp", calculator));
  trace.receive({ type: "response", requestId: "openApp", result: action(calculator, false) });
  trace.receive(request("type", textEdit, "foreign", "another-thread"));
  trace.receive({ type: "response", requestId: "foreign", result: action(textEdit) });
  expect(trace.snapshot()).toMatchObject({
    textEditInspected: false,
    calculatorOpened: false,
    textEditTyping: false,
    unexpectedAppInput: false,
  });
  trace.receive(request("elementAction", "com.apple.calculator.lookalike"));
  trace.receive({ type: "response", requestId: "elementAction", result: action(calculator) });
  expect(trace.snapshot()).toMatchObject({ calculatorPresses: 0, unexpectedAppInput: true });
});
it("cannot count retries or overwrite a failed result with a later success", () => {
  const trace = new RehearsalRealAppsObservation("thread");
  trace.receive(request("openApp"));
  trace.receive({
    type: "response",
    requestId: "openApp",
    error: { _tag: "Interrupted", cause: "paused" },
  });
  trace.receive(request("openApp"));
  trace.receive({ type: "response", requestId: "openApp", result: action(calculator) });
  expect(trace.snapshot().calculatorOpened).toBe(false);
  trace.receive(request("elementAction"));
  trace.receive({ type: "response", requestId: "elementAction", result: action(calculator) });
  trace.receive({ type: "response", requestId: "elementAction", result: action(calculator) });
  expect(trace.snapshot().calculatorPresses).toBe(1);
});
it("bounds admission and refuses unknown successful input recipients", () => {
  const trace = new RehearsalRealAppsObservation("thread");
  trace.receive(request("type", textEdit));
  trace.receive({ type: "response", requestId: "type", result: action("other-app") });
  for (let index = 0; index < 129; index++)
    trace.receive(request("inspect", calculator, String(index)));
  expect(trace.snapshot()).toMatchObject({
    unexpectedAppInput: true,
    traceComplete: false,
    textEditTyping: false,
  });
});
it("records only fixed expected text and exact command chords after correlated success", () => {
  const trace = new RehearsalRealAppsObservation("thread");
  const type = request("type", textEdit);
  trace.receive({ ...type, request: { ...type.request, text: REAL_APP_REHEARSAL_TEXT } });
  trace.receive({ type: "response", requestId: "type", result: action(textEdit) });
  for (const [id, chord] of [
    ["select", "Command+A"],
    ["save", "META+S"],
  ]) {
    const key = request("key", textEdit, id);
    trace.receive({ ...key, request: { ...key.request, chords: [chord!] } });
    trace.receive({ type: "response", requestId: id, result: action(textEdit) });
  }
  expect(trace.snapshot()).toMatchObject({
    expectedTextTyping: true,
    selectAllKeySucceeded: true,
    saveKeySucceeded: true,
  });
  expect(JSON.stringify(trace.snapshot())).not.toContain(REAL_APP_REHEARSAL_TEXT);
});
it("does not credit wrong modifiers, combined chords, failed input or another app", () => {
  const trace = new RehearsalRealAppsObservation("thread");
  for (const [id, chords] of [
    ["control", ["CTRL+A"]],
    ["combined", ["CMD+A", "CMD+S"]],
  ] as const) {
    const key = request("key", textEdit, id);
    trace.receive({ ...key, request: { ...key.request, chords: [...chords] } });
    trace.receive({ type: "response", requestId: id, result: action(textEdit) });
  }
  const key = request("key", textEdit, "failed");
  trace.receive({ ...key, request: { ...key.request, chords: ["CMD+S"] } });
  trace.receive({
    type: "response",
    requestId: "failed",
    error: { _tag: "Interrupted", cause: "paused" },
  });
  const type = request("type", calculator);
  trace.receive({ ...type, request: { ...type.request, text: REAL_APP_REHEARSAL_TEXT } });
  trace.receive({ type: "response", requestId: "type", result: action(calculator) });
  expect(trace.snapshot()).toMatchObject({
    expectedTextTyping: false,
    selectAllKeySucceeded: false,
    saveKeySucceeded: false,
  });
});

it("keeps ambiguous mutation failures latched even if a new request later succeeds", () => {
  const trace = new RehearsalRealAppsObservation("thread");
  trace.receive(request("type", textEdit, "first"));
  trace.receive({ type: "response", requestId: "first", error: { _tag: "OutcomeUnknown" } });
  trace.receive(request("type", textEdit, "second"));
  trace.receive({ type: "response", requestId: "second", result: action(textEdit) });
  expect(trace.snapshot()).toMatchObject({
    textEditTyping: true,
    failedMutations: 1,
    ambiguousMutations: 1,
    typingRequests: 2,
  });
  expect(JSON.stringify(trace.snapshot())).not.toContain("PRIVATE_SENTINEL");
});

it("does not mistake missing or malformed terminal responses for a complete trace", () => {
  const trace = new RehearsalRealAppsObservation("thread");
  trace.receive(request("inspect", textEdit));
  expect(trace.snapshot().traceComplete).toBe(false);
  trace.receive({ type: "response", requestId: "inspect", result: {} });
  expect(trace.snapshot().traceComplete).toBe(false);
});

it("records a failed observation separately without losing successful input proof", () => {
  const trace = new RehearsalRealAppsObservation("thread");
  trace.receive(request("inspect", textEdit));
  trace.receive({
    type: "response",
    requestId: "inspect",
    error: { _tag: "Execution", message: "PRIVATE_SENTINEL" },
  });
  expect(trace.snapshot()).toMatchObject({
    observationFailures: 1,
    failedMutations: 0,
    ambiguousMutations: 0,
    traceComplete: true,
  });
  expect(JSON.stringify(trace.snapshot())).not.toContain("PRIVATE_SENTINEL");
});
