/** Wall-clock deadlines are rearmed after drift; consumed cursors are never rewound. */
export function detectScheduledClockJump(
  previous: { wall: number; monotonic: number },
  current: { wall: number; monotonic: number },
): boolean {
  return Math.abs(current.wall - previous.wall - (current.monotonic - previous.monotonic)) > 5000;
}
export function scheduledDeadlineDelay(deadlines: ReadonlyArray<number>, now: number): number {
  return deadlines.length
    ? Math.max(1, Math.min(2147483647, Math.min(...deadlines) - now))
    : 2147483647;
}
