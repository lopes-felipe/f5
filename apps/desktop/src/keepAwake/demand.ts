import { DESKTOP_ACTIVITY_PATH } from "@t3tools/shared/backendPaths";

export interface ActivityBackend {
  origin: string;
  token: string;
}
export async function pollActivity(
  backends: readonly ActivityBackend[],
  request = fetch,
): Promise<number> {
  const results = await Promise.allSettled(
    backends.map(async ({ origin, token }) => {
      const response = await request(origin + DESKTOP_ACTIVITY_PATH, {
        headers: { Authorization: "Bearer " + token },
        signal: AbortSignal.timeout(2000),
        redirect: "error",
      });
      if (!response.ok) return 0;
      const data: unknown = await response.json();
      const count =
        data && typeof data === "object" && "busyThreadCount" in data ? data.busyThreadCount : null;
      return typeof count === "number" && Number.isSafeInteger(count) && count >= 0 ? count : 0;
    }),
  );
  return results.reduce(
    (sum, result) => sum + (result.status === "fulfilled" ? result.value : 0),
    0,
  );
}
