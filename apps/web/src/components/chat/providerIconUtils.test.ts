import { describe, expect, it } from "vitest";

import { getProviderLabel } from "./providerIconUtils";

const model = (subProvider?: string) => ({ slug: "a/b", name: "Step 5", subProvider });

describe("getProviderLabel", () => {
  it("shows a sub-provider named after its provider on its own", () => {
    expect(getProviderLabel("opencode", model("OpenCode Zen"))).toBe("OpenCode Zen");
    expect(getProviderLabel("opencode", model("OpenCode Go"))).toBe("OpenCode Go");
  });

  it("keeps a provider id that merely starts like the provider name", () => {
    expect(getProviderLabel("opencode", model("opencode-go"))).toBe("OpenCode · opencode-go");
  });

  it("joins a sub-provider that names something else", () => {
    expect(getProviderLabel("opencode", model("GitHub Copilot"))).toBe("OpenCode · GitHub Copilot");
  });

  it("keeps the provider name when a model has no sub-provider", () => {
    expect(getProviderLabel("claudeAgent", model())).toBe("Claude");
    expect(getProviderLabel("claudeAgent")).toBe("Claude");
  });
});
