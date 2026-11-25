import { ProviderInstanceId } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import {
  claudeRuntimeSettings,
  resolveClaudeRuntimeModelSelection,
} from "./ClaudeRuntimeConfig.ts";

describe("ClaudeRuntimeConfig", () => {
  it("resolves model selection bound to the active instance and formats runtime settings", () => {
    const providerInstanceId = ProviderInstanceId.make("claudeAgent");
    const resolved = resolveClaudeRuntimeModelSelection({
      providerInstanceId,
      model: "claude-sonnet-4-6",
      modelSelection: {
        instanceId: providerInstanceId,
        model: "claude-opus-4-6",
        options: [{ id: "effort", value: "high" }],
      },
    });
    expect(resolved.baseModel).toBe("claude-opus-4-6");
    expect(claudeRuntimeSettings({ fastMode: true })).toEqual({ fastMode: true });
    expect(claudeRuntimeSettings({ fastMode: false })).toEqual({});
  });
});
