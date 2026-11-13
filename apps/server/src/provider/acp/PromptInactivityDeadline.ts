/** Tracks actual progress and pause transitions using the caller's clock. */
export class PromptInactivityDeadline {
  private lastProgressAt: number;
  private wasPaused = false;
  private batch: number | null = null;
  private batchGraceUntil = 0;
  constructor(
    private readonly timeoutMs: number,
    now: number,
  ) {
    this.lastProgressAt = now;
  }

  remaining(now: number, progressAt: number, paused: boolean, batch: number | null): number {
    if (batch !== this.batch) {
      this.batch = batch;
      // Antigravity only reports a batch launch, not individual child exits.
      // Give it one bounded grace period, or end it when the parent resumes.
      this.batchGraceUntil = batch === null ? 0 : now + this.timeoutMs;
    }
    const pause = paused || (batch !== null && now < this.batchGraceUntil);
    this.lastProgressAt = Math.max(this.lastProgressAt, progressAt);
    if (pause || this.wasPaused) this.lastProgressAt = now;
    this.wasPaused = pause;
    return Math.max(0, this.lastProgressAt + this.timeoutMs - now);
  }
}
