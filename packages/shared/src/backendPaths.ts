/** HTTP paths requiring backend authentication in both server and desktop. */
export const PRIVATE_BACKEND_PATH_PREFIXES = ["/attachments/", "/api/"] as const;
export const DESKTOP_ACTIVITY_PATH = "/api/desktop/activity";
export const ORCHESTRATION_STARTUP_SNAPSHOT_PATH = "/api/orchestration/startup-snapshot";
export interface DesktopBackendActivity {
  readonly busyThreadCount: number;
}

export function isPrivateHttpPath(pathname: string): boolean {
  return PRIVATE_BACKEND_PATH_PREFIXES.some((prefix) => pathname.startsWith(prefix));
}
