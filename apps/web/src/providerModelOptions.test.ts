import { describe, expect, it } from "vitest";

import {
  normalizeProviderModelOptions,
  providerModelOptionsToSelections,
  providerSelectionsToModelOptions,
} from "./providerModelOptions";

describe("providerModelOptions", () => {
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
});
