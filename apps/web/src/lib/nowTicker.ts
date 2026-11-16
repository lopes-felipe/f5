import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";

/**
 * One shared 1 Hz clock. The interval runs only while something subscribes,
 * and `getSnapshot` returns the cached tick so every subscriber renders the
 * same value and unrelated renders never see a fresh `Date.now()`.
 */
export const NOW_TICK_INTERVAL_MS = 1000;

const listeners = new Set<() => void>();
const systemClock = () => Date.now();
let readClock: () => number = systemClock;
let lastTick = readClock();
let timer: ReturnType<typeof setInterval> | null = null;

function tick(): void {
  lastTick = readClock();
  for (const listener of listeners) listener();
}

// Background tabs throttle intervals; catch up as soon as the page is visible.
function onVisibilityChange(): void {
  if (typeof document !== "undefined" && document.visibilityState === "visible") tick();
}

function start(): void {
  lastTick = readClock();
  timer = setInterval(tick, NOW_TICK_INTERVAL_MS);
  if (typeof document !== "undefined") {
    document.addEventListener("visibilitychange", onVisibilityChange);
  }
}

function stop(): void {
  if (timer !== null) clearInterval(timer);
  timer = null;
  if (typeof document !== "undefined") {
    document.removeEventListener("visibilitychange", onVisibilityChange);
  }
}

export function subscribeNow(listener: () => void): () => void {
  listeners.add(listener);
  if (timer === null) start();
  return () => {
    if (!listeners.delete(listener)) return;
    if (listeners.size === 0) stop();
  };
}

export function getNowSnapshot(): number {
  // While idle the cached tick goes stale; the first subscriber renders before
  // it subscribes, so refresh it here. Refreshing at most once per interval
  // keeps repeated reads within one render stable.
  if (timer === null) {
    const now = readClock();
    if (now - lastTick >= NOW_TICK_INTERVAL_MS) lastTick = now;
  }
  return lastTick;
}

export function isNowTickerRunning(): boolean {
  return timer !== null;
}

/** Test seam: replaces the clock (null restores it) and notifies subscribers immediately. */
export function setNowTickerClockForTests(clock: (() => number) | null): void {
  readClock = clock ?? systemClock;
  tick();
}

const noopUnsubscribe = () => {};

/**
 * Epoch milliseconds that advance once per second while `enabled`. Disabled
 * callers do not subscribe and keep the last value they showed (their mount
 * time if they never ticked), so only the leaf that displays a live duration
 * re-renders on each tick and a stopped clock never jumps backwards.
 */
export function useNow(enabled: boolean): number {
  const [mountedAt] = useState(() => readClock());
  const lastShownRef = useRef(mountedAt);
  const subscribe = useCallback(
    (listener: () => void) => (enabled ? subscribeNow(listener) : noopUnsubscribe),
    [enabled],
  );
  const frozen = lastShownRef.current;
  const getSnapshot = enabled ? getNowSnapshot : () => frozen;
  const now = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  useEffect(() => {
    lastShownRef.current = now;
  }, [now]);
  return now;
}

export function useNowIso(enabled: boolean): string {
  return new Date(useNow(enabled)).toISOString();
}

const MINUTE_MS = 60_000;

function getMinuteSnapshot(): number {
  const now = getNowSnapshot();
  return now - (now % MINUTE_MS);
}

/**
 * The shared clock floored to the minute, for relative labels ("5m ago"). It
 * rides the 1 Hz ticker but re-renders its caller only when the minute turns.
 */
export function useNowMinute(): number {
  return useSyncExternalStore(subscribeNow, getMinuteSnapshot, getMinuteSnapshot);
}

function getHourSnapshot(): number {
  // Local hour, so half-hour time zones turn at their own hour and midnight.
  const hour = new Date(getNowSnapshot());
  hour.setMinutes(0, 0, 0);
  return hour.getTime();
}

/**
 * The shared clock floored to the local hour, for greetings and day buckets
 * ("Today", "Yesterday"); re-renders its caller once an hour.
 */
export function useNowHour(): number {
  return useSyncExternalStore(subscribeNow, getHourSnapshot, getHourSnapshot);
}
