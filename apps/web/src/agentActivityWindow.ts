export const AGENT_ACTIVITY_WINDOW_MS = 15_000;
export function isAgentActivityRecent(at: number, now: number): boolean {
  return now - at < AGENT_ACTIVITY_WINDOW_MS;
}
