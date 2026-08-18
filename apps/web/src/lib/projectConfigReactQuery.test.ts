import { describe, expect, it, vi } from "vitest";

import { resolveProjectThreadEnvModeImmediately } from "./projectConfigReactQuery";

describe("resolveProjectThreadEnvModeImmediately", () => {
  it("returns the global default without waiting for an uncached config read", () => {
    const prefetchConfig = vi.fn();

    expect(
      resolveProjectThreadEnvModeImmediately({
        options: {},
        projectDefault: null,
        cachedConfigDefault: null,
        globalDefault: "local",
        prefetchConfig,
      }),
    ).toBe("local");
    expect(prefetchConfig).toHaveBeenCalledOnce();
  });

  it("uses a cached checked-in default without starting another read", () => {
    const prefetchConfig = vi.fn();

    expect(
      resolveProjectThreadEnvModeImmediately({
        options: {},
        projectDefault: null,
        cachedConfigDefault: "worktree",
        globalDefault: "local",
        prefetchConfig,
      }),
    ).toBe("worktree");
    expect(prefetchConfig).not.toHaveBeenCalled();
  });
});
