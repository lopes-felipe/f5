import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { resolveComputerBackendSelection } from "./computerBackendPolicy";
describe("computer installation fingerprint", () => {
  it("does not restart provider sessions for recoverable native health changes", async () => {
    const initial = await Effect.runPromise(
      resolveComputerBackendSelection({
        provider: "claude",
        enabled: true,
        nativeStatus: { available: true },
      }),
    );
    for (const reason of [
      "missing-permissions",
      "monitor-unhealthy",
      "helper-crashed",
      "helper-missing",
    ] as const) {
      const recovered = await Effect.runPromise(
        resolveComputerBackendSelection({
          provider: "claude",
          enabled: true,
          nativeStatus: { available: false, reason },
        }),
      );
      if (process.platform === "darwin" || process.platform === "win32")
        expect(recovered.fingerprint).toBe(initial.fingerprint);
      expect(recovered.status).toMatchObject({ available: false, reason });
    }
  });
});
