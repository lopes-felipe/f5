import type { StopInputSample, StopLatencyEvidence } from "./stopLatencyMeasurement";

/** Timing-only observation of the helper and synthetic fixture. This is never
 * an input source, and does not retain key codes, characters or native payloads. */
export class RehearsalStopObservation {
  readonly evidence: StopLatencyEvidence = {
    samples: [],
    mutationInterrupted: false,
    pausedMutationRefused: false,
    leaseReleased: false,
    fixtureStillFrontmost: false,
    overflow: false,
  };
  private readonly samples: StopInputSample[] = [];
  readonly calibrations: number[] = [];
  heartbeatSequence = 0;
  private physicalSignals = 0;
  private chordSignals = 0;
  private permitExpirations = 0;
  private unhealthyHeartbeats = 0;
  constructor() {
    this.evidence.samples = this.samples;
  }
  helper(raw: unknown): void {
    if (!raw || typeof raw !== "object") return;
    const value = raw as Record<string, unknown>;
    if (value.type === "heartbeat") this.heartbeatSequence++;
    if (value.type === "heartbeat" && value.monitorHealthy === false) this.unhealthyHeartbeats++;
    if (value.type === "permitExpired" && this.finite(value.executionGeneration))
      this.permitExpirations++;
    if (!this.finite(value.recognizedAtMs)) return;
    if (value.type === "physicalInput") {
      this.physicalSignals++;
      this.evidence.physicalRecognizedAtMs ??= value.recognizedAtMs;
    }
    if (value.type === "killSwitch") {
      this.chordSignals++;
      this.evidence.chordRecognizedAtMs ??= value.recognizedAtMs;
    }
  }
  fixture(raw: unknown): void {
    if (!raw || typeof raw !== "object") {
      this.evidence.overflow = true;
      return;
    }
    const value = raw as Record<string, unknown>;
    if (!this.finite(value.observedAtMs)) {
      this.evidence.overflow = true;
      return;
    }
    if (value.kind === "calibration") {
      if (this.calibrations.length < 3) this.calibrations.push(value.observedAtMs);
      else this.evidence.overflow = true;
    } else if (value.kind === "prompt") this.evidence.promptAtMs = value.observedAtMs;
    else if (value.kind === "finished") {
      this.evidence.observationEndedAtMs = value.observedAtMs;
      this.evidence.fixtureStillFrontmost = value.frontmost === true;
    } else if (value.kind === "countdown") return;
    else if (
      (value.kind === "injected" || value.kind === "physical" || value.kind === "chord") &&
      this.finite(value.eventAtMs) &&
      typeof value.keyDown === "boolean" &&
      this.samples.length < 8192
    ) {
      this.samples.push({
        kind: value.kind,
        eventAtMs: value.eventAtMs,
        observedAtMs: value.observedAtMs,
        keyDown: value.keyDown,
      });
    } else this.evidence.overflow = true;
  }
  private finite(value: unknown): value is number {
    return typeof value === "number" && Number.isFinite(value) && value >= 0;
  }
  snapshot() {
    return {
      heartbeatSequence: this.heartbeatSequence,
      physicalRecognizedAtMs: this.evidence.physicalRecognizedAtMs,
      chordRecognizedAtMs: this.evidence.chordRecognizedAtMs,
    };
  }
  /** Counts only: compare a post-consent baseline with failure diagnostics.
   * Does not retain input content or change stop timing evidence. */
  diagnostics() {
    return {
      physicalSignals: this.physicalSignals,
      chordSignals: this.chordSignals,
      permitExpirations: this.permitExpirations,
      unhealthyHeartbeats: this.unhealthyHeartbeats,
    };
  }
}
