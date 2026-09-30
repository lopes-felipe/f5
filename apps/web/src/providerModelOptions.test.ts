import { describe, expect, it } from "vitest";

import {
  normalizeProviderModelOptions,
  providerModelOptionsToSelections,
  providerSelectionsToModelOptions,
} from "./providerModelOptions";
import {
  resolveCodexReasoningEffortForModel,
  normalizeCodexModelOptions,
} from "@t3tools/shared/model";

describe("providerModelOptions", () => {
  it("serializes Sol Ultra and omits its default High effort", () => {
    const codex = normalizeCodexModelOptions("gpt-6.1-sol", { reasoningEffort: "ultra" });
    expect(providerModelOptionsToSelections("codex", { codex })).toEqual([
      { id: "reasoningEffort", value: "ultra" },
    ]);
    const defaults = normalizeCodexModelOptions("gpt-6.1-sol", { reasoningEffort: "high" });
    expect(
      providerModelOptionsToSelections("codex", defaults ? { codex: defaults } : undefined),
    ).toBeUndefined();
    expect(resolveCodexReasoningEffortForModel("gpt-6.1-sol", defaults?.reasoningEffort)).toBe(
      "high",
    );
  });
  it("normalizes non-default Codex reasoning efforts from the shared effort options", () => {
    expect(
      normalizeProviderModelOptions({
        codex: {
          reasoningEffort: "max",
        },
      }),
    ).toEqual({
      codex: {
        reasoningEffort: "max",
      },
    });

    expect(
      normalizeProviderModelOptions({
        codex: {
          reasoningEffort: "ultra",
          fastMode: true,
        },
      }),
    ).toEqual({
      codex: {
        reasoningEffort: "ultra",
        fastMode: true,
      },
    });

    expect(normalizeProviderModelOptions({}, "codex", { effort: "ultra" })).toEqual({
      codex: {
        reasoningEffort: "ultra",
      },
    });
  });

  it("round-trips Codex max and ultra option selections", () => {
    expect(
      providerSelectionsToModelOptions("codex", [{ id: "reasoningEffort", value: "ultra" }]),
    ).toEqual({
      codex: {
        reasoningEffort: "ultra",
      },
    });

    expect(
      providerModelOptionsToSelections("codex", {
        codex: {
          reasoningEffort: "max",
        },
      }),
    ).toEqual([{ id: "reasoningEffort", value: "max" }]);
  });

  it("serializes the model-aware Astra effort used for dispatch", () => {
    const codex = normalizeCodexModelOptions("gpt-6-astra", {
      reasoningEffort: "ultra",
    });

    expect(providerModelOptionsToSelections("codex", codex ? { codex } : undefined)).toEqual([
      { id: "reasoningEffort", value: "max" },
    ]);
  });

  it("normalizes Cursor runtime model options without dropping false booleans", () => {
    expect(
      normalizeProviderModelOptions({
        cursor: {
          reasoning: "high",
          fastMode: false,
          thinking: false,
          contextWindow: "200k",
        },
      }),
    ).toEqual({
      cursor: {
        reasoning: "high",
        fastMode: false,
        thinking: false,
        contextWindow: "200k",
      },
    });
  });

  it("converts Cursor option selections to the provider modelOptions shape", () => {
    expect(
      providerSelectionsToModelOptions("cursor", [
        { id: "reasoning", value: "max" },
        { id: "fastMode", value: true },
        { id: "thinking", value: false },
        { id: "contextWindow", value: "1m" },
      ]),
    ).toEqual({
      cursor: {
        reasoning: "max",
        fastMode: true,
        thinking: false,
        contextWindow: "1m",
      },
    });
  });

  it("converts Cursor modelOptions back to adapter option selections", () => {
    expect(
      providerModelOptionsToSelections("cursor", {
        cursor: {
          reasoning: "xhigh",
          fastMode: true,
          thinking: false,
          contextWindow: "272k",
        },
      }),
    ).toEqual([
      { id: "reasoning", value: "xhigh" },
      { id: "thinking", value: false },
      { id: "fastMode", value: true },
      { id: "contextWindow", value: "272k" },
    ]);
  });

  it("converts Claude option selections with context window to modelOptions", () => {
    expect(
      providerSelectionsToModelOptions("claudeAgent", [
        { id: "effort", value: "max" },
        { id: "contextWindow", value: "200k" },
      ]),
    ).toEqual({
      claudeAgent: {
        effort: "max",
        contextWindow: "200k",
      },
    });
  });

  it("converts Claude modelOptions with context window back to selections", () => {
    expect(
      providerModelOptionsToSelections("claudeAgent", {
        claudeAgent: {
          effort: "max",
          contextWindow: "1m",
        },
      }),
    ).toEqual([
      { id: "effort", value: "max" },
      { id: "contextWindow", value: "1m" },
    ]);
  });
});
