import { expect, it } from "vitest";
import { measureStopLatency, type StopLatencyEvidence } from "./stopLatencyMeasurement";

const evidence: StopLatencyEvidence = {
  samples: [
    ...Array.from({ length: 8 }, (_, index) => ({
      kind: "injected" as const,
      eventAtMs: 1050 + index * 20,
      observedAtMs: 1051 + index * 20,
      keyDown: true,
    })),
    { kind: "physical", eventAtMs: 1200, observedAtMs: 1202, keyDown: false },
    { kind: "injected", eventAtMs: 1204, observedAtMs: 1205, keyDown: false },
    { kind: "chord", eventAtMs: 1240, observedAtMs: 1242, keyDown: true },
  ],
  physicalRecognizedAtMs: 1200,
  chordRecognizedAtMs: 1240,
  promptAtMs: 1195,
  observationEndedAtMs: 1800,
  mutationInterrupted: true,
  pausedMutationRefused: true,
  leaseReleased: true,
  fixtureStillFrontmost: true,
  overflow: false,
};
it("counts held-input release in the stop tail without retaining key contents", () => {
  expect(measureStopLatency(evidence)).toMatchObject({
    state: "passed",
    physicalInputTailMs: 4,
    killChordTailMs: 0,
    appDeliveryTailMs: 5,
    chordEventsObserved: 1,
    chordEventToRecognitionDeltaMs: 0,
  });
});
it("distinguishes a missing independent chord receipt from a mismatched timestamp", () => {
  const missing = measureStopLatency({
    ...evidence,
    samples: evidence.samples.filter((sample) => sample.kind !== "chord"),
  });
  expect(missing.state).toBe("failed");
  expect(missing.chordEventsObserved).toBe(0);
  expect(missing).not.toHaveProperty("chordEventToRecognitionDeltaMs");
  const delayed = measureStopLatency({
    ...evidence,
    samples: evidence.samples.map((sample) =>
      sample.kind === "chord" ? { ...sample, eventAtMs: 1440, observedAtMs: 1442 } : sample,
    ),
  });
  expect(delayed.state).toBe("failed");
  expect(delayed.chordEventsObserved).toBe(1);
  expect(delayed.chordEventToRecognitionDeltaMs).toBe(200);
});
it("fails when any input emission or app delivery reaches the 100 ms boundary", () => {
  for (const sample of [
    { kind: "injected" as const, eventAtMs: 1300, observedAtMs: 1301, keyDown: true },
    { kind: "injected" as const, eventAtMs: 1204, observedAtMs: 1300, keyDown: false },
  ])
    expect(measureStopLatency({ ...evidence, samples: [...evidence.samples, sample] }).state).toBe(
      "failed",
    );
});
it("does not certify missing samples, recognition or an incomplete chord", () => {
  for (const change of [
    { samples: [] },
    { physicalRecognizedAtMs: undefined },
    { chordRecognizedAtMs: undefined },
    { samples: evidence.samples.filter((sample) => sample.kind !== "chord") },
    {
      samples: evidence.samples.map((sample) => ({
        ...sample,
        eventAtMs: sample.eventAtMs - 2000,
      })),
    },
    { observationEndedAtMs: 1500 },
    { overflow: true },
    { mutationInterrupted: false },
    { pausedMutationRefused: false },
    { fixtureStillFrontmost: false },
  ])
    expect(measureStopLatency({ ...evidence, ...change } as StopLatencyEvidence).state).toBe(
      "failed",
    );
});
it("requires the whole physical chord to fall inside conservative host-stall clock bounds", () => {
  const hostStall = { startMs: 100, endMs: 800, offsetMinMs: 1000, offsetMaxMs: 1002 };
  expect(measureStopLatency({ ...evidence, hostStall }).state).toBe("passed");
  for (const changed of [
    { ...hostStall, startMs: 199 },
    { ...hostStall, endMs: 239 },
    { ...hostStall, offsetMaxMs: 1030 },
    { ...hostStall, endMs: 50 },
  ])
    expect(measureStopLatency({ ...evidence, hostStall: changed }).state).toBe("failed");
});
it("requires input to have been active near recognition and the prompt already visible", () => {
  expect(measureStopLatency({ ...evidence, promptAtMs: 1201 }).state).toBe("failed");
  expect(
    measureStopLatency({
      ...evidence,
      samples: evidence.samples.map((sample) =>
        sample.kind === "injected" ? { ...sample, eventAtMs: 800, observedAtMs: 801 } : sample,
      ),
    }).state,
  ).toBe("failed");
});
it("requires the backend to remain stopped when that mode is selected", () => {
  expect(measureStopLatency({ ...evidence, backendFrozenAtStop: true }).state).toBe("passed");
  expect(measureStopLatency({ ...evidence, backendFrozenAtStop: false }).state).toBe("failed");
});
it("requires the whole chord inside independently calibrated backend freeze bounds", () => {
  const backendFreeze = { startMs: 100, endMs: 800, offsetMinMs: 1000, offsetMaxMs: 1002 };
  expect(
    measureStopLatency({ ...evidence, backendFrozenAtStop: true, backendFreeze }),
  ).toMatchObject({
    state: "passed",
    checks: { backendClockCalibrated: true, physicalAndChordDuringBackendFreeze: true },
  });
  for (const changed of [
    { ...backendFreeze, startMs: 199 },
    { ...backendFreeze, endMs: 239 },
    { ...backendFreeze, offsetMaxMs: 1030 },
  ])
    expect(
      measureStopLatency({ ...evidence, backendFrozenAtStop: true, backendFreeze: changed }).state,
    ).toBe("failed");
});
it("requires physical input and the whole chord inside a separately calibrated renderer freeze", () => {
  const rendererFreeze = { startMs: 100, endMs: 800, offsetMinMs: 1000, offsetMaxMs: 1002 };
  const result = measureStopLatency({ ...evidence, rendererFreeze });
  expect(result.state).toBe("passed");
  expect(result.checks).toMatchObject({
    rendererClockCalibrated: true,
    physicalAndChordDuringRendererFreeze: true,
  });
  expect(result.checks).not.toHaveProperty("physicalAndChordDuringHostStall");
  for (const changed of [
    { ...rendererFreeze, startMs: 199 },
    { ...rendererFreeze, endMs: 239 },
    { ...rendererFreeze, offsetMaxMs: 1030 },
  ])
    expect(measureStopLatency({ ...evidence, rendererFreeze: changed }).state).toBe("failed");
});
it("reports conservative relative stall offsets without exposing native clock origins", () => {
  const hostStall = { startMs: 100, endMs: 800, offsetMinMs: 1000, offsetMaxMs: 1002 };
  expect(measureStopLatency({ ...evidence, hostStall })).toMatchObject({
    physicalRecognitionAfterStallStartMs: { min: 98, max: 100 },
    chordRecognitionAfterStallEndMs: { min: -562, max: -560 },
  });
  const uncertainEnd = measureStopLatency({
    ...evidence,
    hostStall: { ...hostStall, endMs: 239 },
  });
  expect(uncertainEnd.state).toBe("failed");
  expect(uncertainEnd.chordRecognitionAfterStallEndMs).toEqual({ min: -1, max: 1 });
});
it("omits relative offsets when recognition or clock calibration is invalid", () => {
  const missingRecognition = {
    ...evidence,
    hostStall: { startMs: 100, endMs: 800, offsetMinMs: 1000, offsetMaxMs: 1002 },
  };
  delete missingRecognition.physicalRecognizedAtMs;
  delete missingRecognition.chordRecognizedAtMs;
  for (const invalid of [
    missingRecognition,
    { ...evidence, hostStall: { startMs: 100, endMs: 800, offsetMinMs: 1000, offsetMaxMs: 1030 } },
  ]) {
    const measurement = measureStopLatency(invalid);
    expect(measurement).not.toHaveProperty("physicalRecognitionAfterStallStartMs");
    expect(measurement).not.toHaveProperty("chordRecognitionAfterStallEndMs");
    expect(measurement.state).toBe("failed");
  }
});
