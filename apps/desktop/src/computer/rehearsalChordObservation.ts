/** Fixed Escape modifier booleans only. No key codes, characters or raw packets. */
export class RehearsalChordObservation {
  constructor(private readonly activeStop = false) {}
  invalid = false;
  monitorHealthy = true;
  chordObserved = false;
  finished = false;
  private promptAtMs: number | undefined;
  private frontmost = false;
  private candidates: Array<{
    observer: "session" | "window";
    control: boolean;
    command: boolean;
    afterPromptMs: number;
  }> = [];
  receive(raw: unknown) {
    if (!raw || typeof raw !== "object") {
      this.invalid = true;
      return;
    }
    const event = raw as Record<string, unknown>;
    if (
      typeof event.observedAtMs !== "number" ||
      !Number.isFinite(event.observedAtMs) ||
      event.observedAtMs < 0
    ) {
      this.invalid = true;
      return;
    }
    if (event.kind === "prompt") this.promptAtMs = event.observedAtMs;
    else if (event.kind === "chordMonitor") this.monitorHealthy = false;
    else if (event.kind === "chordCandidate") {
      if (
        (event.observer !== "session" && event.observer !== "window") ||
        typeof event.control !== "boolean" ||
        typeof event.command !== "boolean" ||
        this.promptAtMs === undefined ||
        event.observedAtMs < this.promptAtMs ||
        this.candidates.length >= 16
      ) {
        this.invalid = true;
        return;
      }
      this.candidates.push({
        observer: event.observer,
        control: event.control,
        command: event.command,
        afterPromptMs: Math.round(event.observedAtMs - this.promptAtMs),
      });
    } else if (event.kind === "chord") {
      if (this.promptAtMs === undefined || event.observedAtMs < this.promptAtMs)
        this.invalid = true;
      else this.chordObserved = true;
    } else if (event.kind === "finished") {
      this.finished = true;
      this.frontmost = event.frontmost === true;
    } else if (
      event.kind !== "physical" &&
      event.kind !== "countdown" &&
      !(this.activeStop && (event.kind === "injected" || event.kind === "calibration"))
    )
      this.invalid = true;
  }
  summary() {
    return {
      traceValid: !this.invalid,
      monitorHealthy: this.monitorHealthy,
      prompted: this.promptAtMs !== undefined,
      chordObserved: this.chordObserved,
      frontmostReceiptObserved: this.finished,
      fixtureStillFrontmost: this.frontmost,
      candidates: this.candidates.map((candidate) => ({ ...candidate })),
    };
  }
}
