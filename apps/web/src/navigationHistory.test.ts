import type { RouterHistory } from "@tanstack/react-router";
import { afterEach, describe, expect, it, vi } from "vitest";

import { canNavigateHistory, navigateHistory } from "./navigationHistory";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("canNavigateHistory", () => {
  it("reads each direction from the Navigation API", () => {
    vi.stubGlobal("window", { navigation: { canGoBack: true, canGoForward: false } });
    expect(canNavigateHistory("back")).toBe(true);
    expect(canNavigateHistory("forward")).toBe(false);
  });

  it("reports nowhere to go without the Navigation API", () => {
    vi.stubGlobal("window", {});
    expect(canNavigateHistory("back")).toBe(false);
    expect(canNavigateHistory("forward")).toBe(false);
  });
});

describe("navigateHistory", () => {
  it("moves through the router history so blockers still apply", () => {
    const history = { back: vi.fn(), forward: vi.fn() };
    navigateHistory(history as unknown as RouterHistory, "back");
    navigateHistory(history as unknown as RouterHistory, "forward");
    expect(history.back).toHaveBeenCalledTimes(1);
    expect(history.forward).toHaveBeenCalledTimes(1);
  });
});
