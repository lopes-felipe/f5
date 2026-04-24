/**
 * Tracks when the user last saw the Home page, used to power the "smart
 * resume" banner. The banner appears when the user returns to Home after a
 * meaningful break so they can jump back into what they were last doing.
 *
 * Stored in localStorage as a millisecond epoch. We use a bare string
 * (rather than JSON) so the value is trivially inspectable and doesn't need
 * schema validation.
 */

const STORAGE_KEY = "t3code:home-last-visit-at:v1";

/** A break of 30 minutes qualifies as "coming back" for the banner trigger. */
export const SMART_RESUME_IDLE_THRESHOLD_MS = 30 * 60 * 1000;

function isBrowser(): boolean {
  return typeof window !== "undefined";
}

export function readLastHomeVisitAt(): number | null {
  if (!isBrowser()) return null;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = Number.parseInt(raw, 10);
    return Number.isFinite(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function writeLastHomeVisitAt(epochMs: number = Date.now()): void {
  if (!isBrowser()) return;
  try {
    window.localStorage.setItem(STORAGE_KEY, String(epochMs));
  } catch {
    // Swallow: this is a soft UX hint, not a critical write.
  }
}

export interface SmartResumeSignal {
  /** Milliseconds since the last Home visit. */
  readonly awayMs: number;
  /** Whether the gap is long enough to surface the banner. */
  readonly shouldOffer: boolean;
}

export function evaluateSmartResume(
  lastVisitAt: number | null,
  now: number = Date.now(),
  thresholdMs: number = SMART_RESUME_IDLE_THRESHOLD_MS,
): SmartResumeSignal {
  if (lastVisitAt === null || !Number.isFinite(lastVisitAt)) {
    return { awayMs: 0, shouldOffer: false };
  }
  const awayMs = Math.max(0, now - lastVisitAt);
  return { awayMs, shouldOffer: awayMs >= thresholdMs };
}

export function formatAwayDuration(awayMs: number): string {
  const minutes = Math.floor(awayMs / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}
