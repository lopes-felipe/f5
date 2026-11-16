import { expect, it } from "vitest";
import { RehearsalStopObservation } from "./rehearsalStopObservation";

it("separates post-consent stop signals without retaining native payloads", () => {
  const trace = new RehearsalStopObservation();
  trace.helper({ type: "physicalInput", recognizedAtMs: 1 });
  const baseline = trace.diagnostics();
  trace.helper({ type: "physicalInput", recognizedAtMs: 2, text: "PRIVATE_SENTINEL" });
  trace.helper({ type: "killSwitch", recognizedAtMs: 3, keyCode: 53 });
  trace.helper({ type: "permitExpired", executionGeneration: 4, private: "PRIVATE_SENTINEL" });
  trace.helper({ type: "heartbeat", monitorHealthy: false });
  trace.helper({ type: "heartbeat", monitorHealthy: true });
  trace.helper({ type: "permitExpired", executionGeneration: NaN });
  trace.helper({ type: "killSwitch", recognizedAtMs: -1 });
  expect(baseline).toEqual({
    physicalSignals: 1,
    chordSignals: 0,
    permitExpirations: 0,
    unhealthyHeartbeats: 0,
  });
  expect(trace.diagnostics()).toEqual({
    physicalSignals: 2,
    chordSignals: 1,
    permitExpirations: 1,
    unhealthyHeartbeats: 1,
  });
  expect(JSON.stringify(trace.diagnostics())).not.toMatch(/PRIVATE_SENTINEL|keyCode/);
});

it("retains only finite recognition timestamps and a heartbeat count", () => {
  const trace = new RehearsalStopObservation();
  trace.helper({ type: "heartbeat", private: "PRIVATE_SENTINEL" });
  trace.helper({ type: "physicalInput", recognizedAtMs: 10, text: "PRIVATE_SENTINEL" });
  trace.helper({ type: "physicalInput", recognizedAtMs: 20 });
  trace.helper({ type: "killSwitch", recognizedAtMs: NaN });
  trace.helper({ type: "killSwitch", recognizedAtMs: 30, keyCode: 53 });
  expect(trace.snapshot()).toEqual({
    heartbeatSequence: 1,
    physicalRecognizedAtMs: 10,
    chordRecognizedAtMs: 30,
  });
  expect(JSON.stringify(trace.evidence)).not.toContain("PRIVATE_SENTINEL");
  expect(JSON.stringify(trace.evidence)).not.toContain("keyCode");
});

it("bounds fixture samples, drops arbitrary fields, and rejects incomplete traces", () => {
  const trace = new RehearsalStopObservation();
  for (let index = 0; index < 8193; index++)
    trace.fixture({
      kind: "injected",
      eventAtMs: index,
      observedAtMs: index + 1,
      keyDown: true,
      text: "PRIVATE_SENTINEL",
      keyCode: 0,
    });
  expect(trace.evidence.samples).toHaveLength(8192);
  expect(trace.evidence.overflow).toBe(true);
  expect(JSON.stringify(trace.evidence)).not.toContain("PRIVATE_SENTINEL");
  expect(trace.evidence.samples[0]).toEqual({
    kind: "injected",
    eventAtMs: 0,
    observedAtMs: 1,
    keyDown: true,
  });
  for (const invalid of [
    null,
    { kind: "physical", observedAtMs: 1 },
    { kind: "injected", observedAtMs: -1 },
  ]) {
    const invalidTrace = new RehearsalStopObservation();
    invalidTrace.fixture(invalid);
    expect(invalidTrace.evidence.overflow).toBe(true);
  }
});

it("keeps three calibration receipts and cue/end timestamps without screen content", () => {
  const trace = new RehearsalStopObservation();
  for (const observedAtMs of [1, 2, 3]) trace.fixture({ kind: "calibration", observedAtMs });
  trace.fixture({ kind: "countdown", observedAtMs: 4 });
  trace.fixture({ kind: "prompt", observedAtMs: 5, text: "PRIVATE_SENTINEL" });
  trace.fixture({ kind: "finished", observedAtMs: 10, frontmost: true });
  expect(trace.calibrations).toEqual([1, 2, 3]);
  expect(trace.evidence).toMatchObject({
    overflow: false,
    promptAtMs: 5,
    observationEndedAtMs: 10,
    fixtureStillFrontmost: true,
  });
  trace.fixture({ kind: "calibration", observedAtMs: 11 });
  expect(trace.evidence.overflow).toBe(true);
});

it("does not assume that the fixture stayed frontmost without its native receipt", () => {
  for (const frontmost of [undefined, false, "true"]) {
    const trace = new RehearsalStopObservation();
    trace.fixture({ kind: "finished", observedAtMs: 10, frontmost });
    expect(trace.evidence.fixtureStillFrontmost).toBe(false);
  }
});
