import { ProviderDriverKind } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import { providerHealthChip } from "./ProviderHealthBanner";

const driver = ProviderDriverKind.makeUnsafe("codex");

describe("providerHealthChip", () => {
  it("folds limited availability into a chip", () => {
    expect(providerHealthChip({ driver, displayName: "Codex", status: "warning" })).toMatchObject({
      tone: "warning",
      label: "Codex limited",
    });
  });

  it("keeps a provider that blocks sends inline", () => {
    expect(providerHealthChip({ driver, status: "disabled" })).toBeNull();
    expect(providerHealthChip({ driver, status: "error" })).toBeNull();
    expect(providerHealthChip({ driver, status: "ready" })).toBeNull();
  });
});
