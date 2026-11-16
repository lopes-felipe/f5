export interface StopInputSample {
  kind: "injected" | "physical" | "chord";
  eventAtMs: number;
  observedAtMs: number;
  keyDown: boolean;
}
export interface StopProcessFreeze {
  startMs: number;
  endMs: number;
  offsetMinMs: number;
  offsetMaxMs: number;
}
export interface StopLatencyEvidence {
  samples: ReadonlyArray<StopInputSample>;
  physicalRecognizedAtMs?: number;
  chordRecognizedAtMs?: number;
  promptAtMs?: number;
  mutationInterrupted: boolean;
  pausedMutationRefused: boolean;
  leaseReleased: boolean;
  fixtureStillFrontmost: boolean;
  overflow: boolean;
  observationEndedAtMs?: number;
  backendFrozenAtStop?: boolean;
  hostStall?: StopProcessFreeze;
  rendererFreeze?: StopProcessFreeze;
  backendFreeze?: StopProcessFreeze;
}
const finite = (value: number | undefined): value is number =>
  value !== undefined && Number.isFinite(value) && value >= 0;
const round = (value: number) => Math.round(value * 10) / 10;

/** Missing/uncertain evidence cannot become a zero-latency passing measurement. */
export function measureStopLatency(evidence: StopLatencyEvidence) {
  const injected = evidence.samples.filter((sample) => sample.kind === "injected");
  const downs = injected.filter((sample) => sample.keyDown);
  const physical = evidence.samples.find((sample) => sample.kind !== "injected");
  const chord = evidence.samples.find((sample) => sample.kind === "chord");
  const lastEvent = injected.length
    ? Math.max(...injected.map((sample) => sample.eventAtMs))
    : undefined;
  const lastDelivery = injected.length
    ? Math.max(...injected.map((sample) => sample.observedAtMs))
    : undefined;
  const lastDown = downs.length ? Math.max(...downs.map((sample) => sample.eventAtMs)) : undefined;
  const physicalAt = evidence.physicalRecognizedAtMs;
  const chordAt = evidence.chordRecognizedAtMs;
  const physicalTailMs =
    finite(lastEvent) && finite(physicalAt) ? Math.max(0, lastEvent - physicalAt) : undefined;
  const chordTailMs =
    finite(lastEvent) && finite(chordAt) ? Math.max(0, lastEvent - chordAt) : undefined;
  const deliveryTailMs =
    finite(lastDelivery) && finite(physicalAt) ? Math.max(0, lastDelivery - physicalAt) : undefined;
  const stall = evidence.hostStall;
  const renderer = evidence.rendererFreeze;
  const backend = evidence.backendFreeze;
  const calibrated = (bounds: StopProcessFreeze) =>
    [bounds.startMs, bounds.endMs, bounds.offsetMinMs, bounds.offsetMaxMs].every(Number.isFinite) &&
    bounds.endMs > bounds.startMs &&
    bounds.offsetMaxMs >= bounds.offsetMinMs &&
    bounds.offsetMaxMs - bounds.offsetMinMs <= 25;
  const duringFreeze = (bounds: StopProcessFreeze) =>
    finite(physicalAt) &&
    finite(chordAt) &&
    physicalAt >= bounds.startMs + bounds.offsetMaxMs &&
    chordAt >= physicalAt &&
    chordAt <= bounds.endMs + bounds.offsetMinMs;
  const checks = {
    traceComplete:
      !evidence.overflow && evidence.samples.length > 0 && evidence.samples.length <= 8192,
    clocksValid: evidence.samples.every(
      (sample) =>
        finite(sample.eventAtMs) &&
        finite(sample.observedAtMs) &&
        sample.observedAtMs - sample.eventAtMs >= -1 &&
        sample.observedAtMs - sample.eventAtMs <= 1000,
    ),
    syntheticInputObserved: downs.length >= 8,
    physicalInputRecognized:
      finite(physicalAt) &&
      physical !== undefined &&
      Math.abs(physical.eventAtMs - physicalAt) <= 100,
    chordRecognized:
      finite(chordAt) && chord !== undefined && Math.abs(chord.eventAtMs - chordAt) <= 100,
    promptedBeforeInterruption:
      finite(evidence.promptAtMs) && finite(physicalAt) && evidence.promptAtMs <= physicalAt,
    typingActiveAtTrigger: finite(lastDown) && finite(physicalAt) && lastDown >= physicalAt - 250,
    physicalStopUnder100Ms: finite(physicalTailMs) && physicalTailMs < 100,
    chordStopUnder100Ms: finite(chordTailMs) && chordTailMs < 100,
    appDeliveryStoppedUnder100Ms: finite(deliveryTailMs) && deliveryTailMs < 100,
    quietTailObserved:
      finite(evidence.observationEndedAtMs) &&
      finite(chordAt) &&
      evidence.observationEndedAtMs - chordAt >= 500,
    inFlightMutationInterrupted: evidence.mutationInterrupted,
    pausedMutationRefused: evidence.pausedMutationRefused,
    leaseReleased: evidence.leaseReleased,
    fixtureStillFrontmost: evidence.fixtureStillFrontmost,
    ...(evidence.backendFrozenAtStop !== undefined
      ? { backendFrozenAtStop: evidence.backendFrozenAtStop }
      : {}),
    ...(renderer
      ? {
          rendererClockCalibrated: calibrated(renderer),
          physicalAndChordDuringRendererFreeze: duringFreeze(renderer),
        }
      : {}),
    ...(backend
      ? {
          backendClockCalibrated: calibrated(backend),
          physicalAndChordDuringBackendFreeze: duringFreeze(backend),
        }
      : {}),
    ...(stall
      ? {
          stallClockCalibrated: calibrated(stall),
          physicalAndChordDuringHostStall: duringFreeze(stall),
        }
      : {}),
  };
  return {
    state: Object.values(checks).every(Boolean) ? ("passed" as const) : ("failed" as const),
    checks,
    injectedKeyDowns: downs.length,
    injectedEvents: injected.length,
    chordEventsObserved: evidence.samples.filter((sample) => sample.kind === "chord").length,
    ...(chord && finite(chordAt)
      ? { chordEventToRecognitionDeltaMs: round(chord.eventAtMs - chordAt) }
      : {}),
    ...(physicalTailMs !== undefined ? { physicalInputTailMs: round(physicalTailMs) } : {}),
    ...(chordTailMs !== undefined ? { killChordTailMs: round(chordTailMs) } : {}),
    ...(deliveryTailMs !== undefined ? { appDeliveryTailMs: round(deliveryTailMs) } : {}),
    ...(finite(physicalAt) && finite(chordAt)
      ? { physicalToChordMs: round(chordAt - physicalAt) }
      : {}),
    ...(renderer ? { rendererFreezeDurationMs: round(renderer.endMs - renderer.startMs) } : {}),
    ...(stall
      ? {
          hostStallDurationMs: round(stall.endMs - stall.startMs),
          clockUncertaintyMs: round(stall.offsetMaxMs - stall.offsetMinMs),
          ...(checks.stallClockCalibrated && finite(physicalAt)
            ? {
                physicalRecognitionAfterStallStartMs: {
                  min: round(physicalAt - stall.startMs - stall.offsetMaxMs),
                  max: round(physicalAt - stall.startMs - stall.offsetMinMs),
                },
              }
            : {}),
          ...(checks.stallClockCalibrated && finite(chordAt)
            ? {
                chordRecognitionAfterStallEndMs: {
                  min: round(chordAt - stall.endMs - stall.offsetMaxMs),
                  max: round(chordAt - stall.endMs - stall.offsetMinMs),
                },
              }
            : {}),
        }
      : {}),
  };
}
