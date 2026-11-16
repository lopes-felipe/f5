import { expect, it } from "vitest";
import { RehearsalChordObservation } from "./rehearsalChordObservation";

it("keeps only Escape modifier flags and relative timings from both observers", () => {
  const trace = new RehearsalChordObservation();
  trace.receive({ kind: "prompt", observedAtMs: 100 });
  for (const observer of ["session", "window"])
    trace.receive({
      kind: "chordCandidate",
      observer,
      control: true,
      command: true,
      observedAtMs: 150,
      keyCode: 53,
      text: "PRIVATE_SENTINEL",
    });
  trace.receive({ kind: "chord", observedAtMs: 150, text: "PRIVATE_SENTINEL" });
  trace.receive({ kind: "finished", observedAtMs: 200, frontmost: true });
  expect(trace.summary()).toMatchObject({
    traceValid: true,
    chordObserved: true,
    fixtureStillFrontmost: true,
    candidates: [
      { observer: "session", control: true, command: true, afterPromptMs: 50 },
      { observer: "window", control: true, command: true, afterPromptMs: 50 },
    ],
  });
  expect(JSON.stringify(trace.summary())).not.toMatch(/PRIVATE_SENTINEL|keyCode|observedAtMs/);
});

it("does not count partial modifiers as a complete chord or unobserved focus as frontmost", () => {
  const trace = new RehearsalChordObservation();
  trace.receive({ kind: "prompt", observedAtMs: 100 });
  trace.receive({
    kind: "chordCandidate",
    observedAtMs: 150,
    observer: "session",
    control: false,
    command: true,
  });
  trace.receive({ kind: "finished", observedAtMs: 200 });
  expect(trace.summary()).toMatchObject({ chordObserved: false, fixtureStillFrontmost: false });
});

it("fails closed on disabled monitoring, malformed traces, injected input and overflow", () => {
  const trace = new RehearsalChordObservation();
  trace.receive({ kind: "chordMonitor", observedAtMs: 1, available: false });
  expect(trace.summary().monitorHealthy).toBe(false);
  for (const invalid of [
    null,
    { kind: "prompt", observedAtMs: NaN },
    { kind: "injected", observedAtMs: 1 },
    { kind: "chordCandidate", observedAtMs: 1, control: true, command: true, observer: "session" },
  ]) {
    const invalidTrace = new RehearsalChordObservation();
    invalidTrace.receive(invalid);
    expect(invalidTrace.summary().traceValid).toBe(false);
  }
  const bounded = new RehearsalChordObservation();
  bounded.receive({ kind: "prompt", observedAtMs: 1 });
  for (let index = 0; index < 17; index++)
    bounded.receive({
      kind: "chordCandidate",
      observedAtMs: index + 1,
      observer: "session",
      control: true,
      command: true,
    });
  expect(bounded.summary().candidates).toHaveLength(16);
  expect(bounded.summary().traceValid).toBe(false);
});

it("active-stop diagnostics accept timing-only calibration and input packets without retaining their data", () => {
  const trace = new RehearsalChordObservation(true);
  trace.receive({ kind: "calibration", observedAtMs: 1, text: "PRIVATE_SENTINEL" });
  trace.receive({ kind: "injected", observedAtMs: 2, text: "PRIVATE_SENTINEL", keyCode: 0 });
  trace.receive({ kind: "prompt", observedAtMs: 3 });
  trace.receive({
    kind: "chordCandidate",
    observedAtMs: 4,
    observer: "session",
    control: true,
    command: false,
  });
  expect(trace.summary()).toMatchObject({ traceValid: true, chordObserved: false });
  expect(JSON.stringify(trace.summary())).not.toMatch(
    /PRIVATE_SENTINEL|keyCode|injected|calibration/,
  );
});
