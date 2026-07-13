import { describe, expect, it } from "vitest";
import { ProviderDriverKind } from "@t3tools/contracts";

import { getModelCompanyLabel } from "./providerInstanceModelGrouping";

describe("getModelCompanyLabel", () => {
  it("prefers explicit lab metadata from aggregator providers", () => {
    expect(
      getModelCompanyLabel({
        driverKind: ProviderDriverKind.make("opencode"),
        instanceDisplayName: "OpenCode",
        name: "Sonnet",
        slug: "anthropic/claude-sonnet-4-6",
        subProvider: "anthropic",
      }),
    ).toBe("Anthropic");
  });

  it("groups known Cursor model families by their originating lab", () => {
    expect(
      getModelCompanyLabel({
        driverKind: ProviderDriverKind.make("cursor"),
        instanceDisplayName: "Cursor",
        name: "Claude Opus 4.6",
        slug: "claude-opus-4-6",
      }),
    ).toBe("Anthropic");
    expect(
      getModelCompanyLabel({
        driverKind: ProviderDriverKind.make("cursor"),
        instanceDisplayName: "Cursor",
        name: "GPT-5.6",
        slug: "gpt-5.6",
      }),
    ).toBe("OpenAI");
  });

  it("falls back to the provider instance for unknown aggregator models", () => {
    expect(
      getModelCompanyLabel({
        driverKind: ProviderDriverKind.make("cursor"),
        instanceDisplayName: "Cursor Work",
        name: "Auto",
        slug: "auto",
      }),
    ).toBe("Cursor Work");
  });
});
