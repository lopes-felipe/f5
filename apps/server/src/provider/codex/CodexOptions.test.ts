import { ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import {
  mergeCodexProviderOptions,
  resolveCodexSelectionOptions,
  toRequestError,
} from "./CodexOptions.ts";

describe("CodexOptions", () => {
  it("prefers bound modelSelection options and merges codex launchArgs", () => {
    const instanceId = ProviderInstanceId.make("codex");
    const bound = resolveCodexSelectionOptions({
      boundInstanceId: instanceId,
      modelOptions: { codex: { reasoningEffort: "low", fastMode: true } },
      modelSelection: {
        instanceId,
        model: "gpt-5.3-codex",
        options: [{ id: "reasoningEffort", value: "high" }],
      },
    });
    expect(bound).toEqual({ reasoningEffort: "high" });

    const merged = mergeCodexProviderOptions(
      { codex: { launchArgs: ["--a"] } },
      { codex: { launchArgs: ["--b"] } },
    );
    expect(merged?.codex?.launchArgs).toEqual(["--a", "--b"]);
  });

  it("preserves delivery metadata on array-shaped causes in toRequestError", () => {
    const cause = Object.assign([], {
      deliveryCertainty: "not_sent",
      deliveryRetryable: true,
    });
    const error = toRequestError(ThreadId.makeUnsafe("thread-1"), "turn/start", cause);
    expect(error._tag).toBe("ProviderAdapterRequestError");
    if (error._tag === "ProviderAdapterRequestError") {
      expect(error.deliveryCertainty).toBe("not_sent");
      expect(error.deliveryRetryable).toBe(true);
    }
  });
});
