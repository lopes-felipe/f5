import { expect, it } from "vitest";
import { WindowsWorkflowTrace } from "./rehearsalWindowsTrace";

it("distinguishes a native uncertain response from a local uncertain failure", () => {
  let now = 10;
  const trace = new WindowsWorkflowTrace(() => now);
  trace.start({ requestId: "one", op: "elementAction", delivery: "background" });
  trace.event({ type: "response", requestId: "other", error: { _tag: "OutcomeUnknown" } });
  trace.event({ type: "response", requestId: "one", error: { _tag: "OutcomeUnknown" } });
  now = 260;
  trace.finish({ error: { _tag: "OutcomeUnknown" } });
  trace.start({ requestId: "two", op: "elementAction", delivery: "background" });
  trace.event({ type: "actionConfirmed", requestId: "two" });
  now = 30_260;
  trace.finish({ error: { _tag: "OutcomeUnknown" } });
  expect(trace.report().operations).toEqual([
    {
      op: "elementAction",
      delivery: "background",
      response: "error",
      actionConfirmed: false,
      nativeError: { code: "OutcomeUnknown" },
      returnedError: { code: "OutcomeUnknown" },
      elapsedMs: 250,
    },
    {
      op: "elementAction",
      delivery: "background",
      response: "none",
      actionConfirmed: true,
      returnedError: { code: "OutcomeUnknown" },
      elapsedMs: 30_000,
    },
  ]);
});
it("retains monitor status and strips protocol contents from successful and failed operations", () => {
  let now = 100;
  const trace = new WindowsWorkflowTrace(() => now);
  trace.start({ requestId: "PRIVATE_ID", op: "inspect" });
  trace.event({ type: "response", requestId: "PRIVATE_ID", result: { nodes: ["PRIVATE_TEXT"] } });
  trace.finish();
  trace.event({
    type: "status",
    status: { available: false, reason: "helper-crashed", detail: "PRIVATE_PATH" },
  });
  trace.event({ type: "heartbeat", monitorHealthy: false, frontmostAppId: "PRIVATE_APP" });
  now = 200;
  expect(trace.report()).toMatchObject({
    lastStatus: { available: false, reason: "helper-crashed" },
    monitorHealthy: false,
    lastHeartbeatAgeMs: 100,
    operations: [{ op: "inspect", response: "ok" }],
  });
  expect(JSON.stringify(trace.report())).not.toContain("PRIVATE");
});
it("records an activation side effect without including native error text", () => {
  const trace = new WindowsWorkflowTrace();
  trace.start({ requestId: "action", op: "elementAction", delivery: "background" });
  trace.event({
    type: "response",
    requestId: "action",
    error: {
      _tag: "ForegroundRequired",
      reason: "activation-side-effect",
      message: "PRIVATE_TEXT",
    },
  });
  trace.finish({ error: { _tag: "ForegroundRequired", reason: "activation-side-effect" } });
  expect(trace.report().operations[0]).toMatchObject({
    response: "error",
    nativeError: { code: "ForegroundRequired", reason: "activation-side-effect" },
    returnedError: { code: "ForegroundRequired", reason: "activation-side-effect" },
  });
  expect(JSON.stringify(trace.report())).not.toContain("PRIVATE");
});
it("bounds stored operations and ignores unrelated or unknown fields", () => {
  const trace = new WindowsWorkflowTrace();
  for (let index = 0; index < 100; index++) {
    trace.start({
      requestId: String(index),
      op: "PRIVATE_OPERATION",
      delivery: "PRIVATE_DELIVERY",
    });
    trace.event({
      type: "response",
      requestId: String(index),
      error: {
        _tag: "TargetBlocked",
        kind: "user-active",
        message: "PRIVATE_MESSAGE",
      },
    });
    trace.finish();
  }
  expect(trace.report().operations).toHaveLength(32);
  expect(trace.report().overflow).toBe(true);
  expect(JSON.stringify(trace.report())).not.toContain("PRIVATE");
});
it("records which hook missed a probe without exposing injected input data", () => {
  const trace = new WindowsWorkflowTrace();
  for (let index = 0; index < 12; index++)
    trace.event({
      type: "hookProbe",
      acknowledged: false,
      mouseQueued: true,
      keyboardQueued: true,
      mouseAcknowledged: false,
      keyboardAcknowledged: true,
      elapsedMs: 500,
      input: "PRIVATE_TEXT",
    });
  trace.event({ type: "hookProbe", acknowledged: "PRIVATE_TEXT", elapsedMs: 500 });
  expect(trace.report().hookProbes).toHaveLength(8);
  expect(trace.report().hookProbes[0]).toEqual({
    acknowledged: false,
    mouseQueued: true,
    keyboardQueued: true,
    mouseAcknowledged: false,
    keyboardAcknowledged: true,
    elapsedMs: 500,
  });
  expect(JSON.stringify(trace.report())).not.toContain("PRIVATE");
});
it("retains the known mouse probe kind and drops unknown diagnostic strings", () => {
  const trace = new WindowsWorkflowTrace();
  const event = {
    type: "hookProbe",
    acknowledged: true,
    mouseQueued: true,
    keyboardQueued: true,
    mouseAcknowledged: true,
    keyboardAcknowledged: true,
    elapsedMs: 250,
  };
  trace.event({ ...event, mouseProbe: "wheel-zero" });
  trace.event({ ...event, mouseProbe: "PRIVATE_TEXT" });
  trace.event({ ...event, mouseProbe: "raw-input-liveness", mouseRegistered: true });
  expect(trace.report().hookProbes[0]?.mouseProbe).toBe("wheel-zero");
  expect(trace.report().hookProbes[1]).not.toHaveProperty("mouseProbe");
  expect(trace.report().hookProbes[2]).toMatchObject({
    mouseProbe: "raw-input-liveness",
    mouseRegistered: true,
  });
  expect(JSON.stringify(trace.report())).not.toContain("PRIVATE");
});
it("reports partial traversal and identity filtering without element contents", () => {
  const trace = new WindowsWorkflowTrace();
  trace.start({ requestId: "inspection", op: "inspect" });
  trace.event({
    type: "accessibilityTraversal",
    requestId: "inspection",
    complete: false,
    visited: 10,
    reported: 2,
    processSkipped: 3,
    runtimeSkipped: 5,
    errors: ["80004005", "PRIVATE_TEXT"],
    nodes: ["PRIVATE_TEXT"],
  });
  trace.finish();
  expect(trace.report().operations[0]?.traversal).toEqual({
    complete: false,
    visited: 10,
    reported: 2,
    processSkipped: 3,
    runtimeSkipped: 5,
    errors: ["80004005"],
  });
  expect(JSON.stringify(trace.report())).not.toContain("PRIVATE");
});
