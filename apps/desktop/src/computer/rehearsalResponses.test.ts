import { describe, expect, it } from "vitest";
import type { ComputerAutomationRequest, DesktopComputerHostMessage } from "@t3tools/contracts";
import { RehearsalResponses } from "./rehearsalResponses";

const request = (op: ComputerAutomationRequest["op"], requestId: string = op) =>
  ({ op, requestId, appId: "fixture" }) as ComputerAutomationRequest;
const response = (requestId: string, result: unknown): DesktopComputerHostMessage => ({
  type: "response",
  requestId,
  result,
});
const screenshot = {
  displayId: "display",
  geometryGeneration: "geometry",
  modelSize: { width: 100, height: 100 },
  mimeType: "image/png",
  data: "aW1hZ2U=",
  hiddenContent: true,
};
const inspect = {
  snapshotId: "snapshot",
  appId: "fixture",
  accessible: true,
  nodes: [
    {
      elementRef: "element",
      role: "AXButton",
      name: "Button",
      focused: false,
      enabled: true,
      actions: ["press"],
    },
  ],
};
const action = {
  displayId: "display",
  geometryGeneration: "geometry",
  frontmostApp: null,
  cursor: null,
};
describe("provider rehearsal response evidence", () => {
  it("requires successful correlated capture, inspection and input responses", () => {
    const evidence = new RehearsalResponses();
    for (const op of ["screenshot", "inspect", "type", "elementAction"] as const)
      evidence.request(request(op));
    expect(Object.values(evidence.checks()).some(Boolean)).toBe(false);
    evidence.response(response("inspect", inspect));
    evidence.response(response("screenshot", screenshot));
    evidence.response(response("elementAction", action));
    expect(evidence.checks().nativeInputSucceeded).toBe(false);
    evidence.response(response("type", action));
    expect(Object.values(evidence.checks()).every(Boolean)).toBe(true);
  });
  it("cannot pass dispatched failed or incomplete observations even after successful inputs", () => {
    const evidence = new RehearsalResponses();
    for (const op of ["screenshot", "inspect", "type", "elementAction"] as const)
      evidence.request(request(op));
    evidence.response({
      type: "response",
      requestId: "screenshot",
      error: { _tag: "Execution", message: "failed" },
    });
    evidence.response(response("type", action));
    evidence.response(response("elementAction", action));
    expect(evidence.checks()).toEqual({
      nativeCaptureSucceeded: false,
      nativeInspectionSucceeded: false,
      nativeInputSucceeded: true,
    });
  });
  it("ignores unknown IDs and later contradictory responses for a failed request", () => {
    const evidence = new RehearsalResponses();
    evidence.response(response("screenshot", screenshot));
    evidence.request(request("screenshot"));
    evidence.response(response("unrelated", screenshot));
    evidence.response({
      type: "response",
      requestId: "screenshot",
      error: { _tag: "Interrupted", cause: "paused" },
    });
    evidence.request(request("screenshot"));
    evidence.response(response("screenshot", screenshot));
    expect(evidence.checks().nativeCaptureSucceeded).toBe(false);
    evidence.request(request("screenshot", "fresh"));
    evidence.response(response("fresh", screenshot));
    expect(evidence.checks().nativeCaptureSucceeded).toBe(true);
  });
  it.each([undefined, {}, { ...screenshot, data: "" }])(
    "refuses invalid capture content %#",
    (result) => {
      const evidence = new RehearsalResponses();
      evidence.request(request("screenshot"));
      evidence.response(response("screenshot", result));
      expect(evidence.checks().nativeCaptureSucceeded).toBe(false);
    },
  );
  it.each([
    undefined,
    {},
    { ...inspect, accessible: false },
    { ...inspect, nodes: [] },
    { ...inspect, appId: "other" },
  ])("refuses unavailable or wrong-app inspection %#", (result) => {
    const evidence = new RehearsalResponses();
    evidence.request(request("inspect"));
    evidence.response(response("inspect", result));
    expect(evidence.checks().nativeInspectionSucceeded).toBe(false);
  });
  it("does not count malformed or explicitly incomplete input results", () => {
    const evidence = new RehearsalResponses();
    evidence.request(request("type"));
    evidence.request(request("elementAction"));
    evidence.response(response("type", {}));
    evidence.response(response("elementAction", { ...action, actionCompleted: false }));
    expect(evidence.checks().nativeInputSucceeded).toBe(false);
  });
});
