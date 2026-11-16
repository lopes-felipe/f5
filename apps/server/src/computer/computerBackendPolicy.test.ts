import { describe, expect, it, vi } from "vitest";
import { Effect } from "effect";
import * as availability from "./computerBuiltinAvailability";
import {
  resolveComputerBackendSelection,
  resolveProviderComputerBackendSelection,
} from "./computerBackendPolicy";

describe("computer configuration provider scope", () => {
  it.each(["opencode", "cursor", "grok", "antigravity", undefined] as const)(
    "never probes or produces restart state for %s",
    async (provider) => {
      const probe = vi.spyOn(availability, "probeComputerBuiltin");
      try {
        for (const enabled of [false, true])
          for (const nativeStatus of [
            { available: true as const },
            { available: false as const, reason: "helper-crashed" as const },
          ])
            expect(
              await Effect.runPromise(
                resolveProviderComputerBackendSelection(provider, { enabled, nativeStatus }),
              ),
            ).toBeUndefined();
        expect(probe).not.toHaveBeenCalled();
      } finally {
        probe.mockRestore();
      }
    },
  );
});

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
      "no-host",
      "not-certified",
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
