import { describe, expect, it } from "vitest";

import { mergeProviderInstanceEnvironment } from "./ProviderInstanceEnvironment.ts";

describe("mergeProviderInstanceEnvironment", () => {
  it("overrides inherited environment values and preserves empty strings", () => {
    expect(
      mergeProviderInstanceEnvironment(
        [
          { name: "OPENROUTER_API_KEY", value: "sk-or-test", sensitive: true },
          { name: "ANTHROPIC_API_KEY", value: "", sensitive: false },
        ],
        { ANTHROPIC_API_KEY: "inherited", PATH: "/bin" },
      ),
    ).toMatchObject({
      OPENROUTER_API_KEY: "sk-or-test",
      ANTHROPIC_API_KEY: "",
      PATH: "/bin",
    });
  });

  it("marks the process for the Agent Bridge recursion guard, even over an override", () => {
    expect(
      mergeProviderInstanceEnvironment(
        [{ name: "F5_AGENT_PROCESS", value: "0", sensitive: false }],
        {
          PATH: "/bin",
        },
      ).F5_AGENT_PROCESS,
    ).toBe("1");
  });
});
