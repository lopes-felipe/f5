import { describe, expect, it, vi } from "vitest";

import { probeNestedSandbox } from "./nestedSandboxProbe.ts";

describe("probeNestedSandbox", () => {
  it("applies the most permissive Seatbelt profile on macOS and passes on exit 0", () => {
    const run = vi.fn(() => ({ status: 0, error: undefined }));
    expect(probeNestedSandbox("darwin", run)).toBe(true);
    expect(run).toHaveBeenCalledWith(
      "/usr/bin/sandbox-exec",
      ["-p", "(version 1)(allow default)", "/usr/bin/true"],
      { timeout: 5_000, stdio: "ignore" },
    );
  });

  it("reports no nested sandbox when sandbox_apply fails or sandbox-exec can't run", () => {
    expect(probeNestedSandbox("darwin", () => ({ status: 71, error: undefined }))).toBe(false);
    expect(
      probeNestedSandbox("darwin", () => ({ status: null, error: new Error("spawn ENOENT") })),
    ).toBe(false);
  });

  it("doesn't check other platforms", () => {
    const run = vi.fn(() => ({ status: 1, error: undefined }));
    expect(probeNestedSandbox("linux", run)).toBe(true);
    expect(probeNestedSandbox("win32", run)).toBe(true);
    expect(run).not.toHaveBeenCalled();
  });
});
