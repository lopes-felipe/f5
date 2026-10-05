import { describe, expect, it } from "vitest";

import { formatUsd } from "./formatUsd";

describe("formatUsd", () => {
  it("shows two decimals", () => {
    expect(formatUsd(1.5)).toBe("$1.50");
    expect(formatUsd(12.345)).toBe("$12.35");
    expect(formatUsd(0.01)).toBe("$0.01");
  });

  it("collapses sub-cent amounts", () => {
    expect(formatUsd(0.004)).toBe("<$0.01");
  });

  it("treats zero, negative and non-finite values as zero", () => {
    expect(formatUsd(0)).toBe("$0.00");
    expect(formatUsd(-3)).toBe("$0.00");
    expect(formatUsd(Number.NaN)).toBe("$0.00");
  });
});
