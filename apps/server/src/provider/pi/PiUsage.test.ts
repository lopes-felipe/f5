import { expect, it } from "vitest";
import { piContextUsage, PiTurnUsage } from "./PiUsage.ts";
it("treats message streaming counters as replacements and charges each completed message once", () => {
  const usage = new PiTurnUsage();
  usage.observe({ type: "message_start", message: { role: "assistant" } });
  for (const output of [1, 2, 3])
    usage.observe({
      type: "message_update",
      usage: { input: 10, output, totalTokens: 10 + output },
    });
  const end = {
    type: "message_end",
    message: {
      role: "assistant",
      usage: {
        input: 10,
        output: 4,
        cacheRead: 5,
        cacheWrite: 1,
        totalTokens: 20,
        cost: { total: 0.02 },
      },
    },
  };
  usage.observe(end);
  usage.observe(end);
  usage.observe({ type: "message_start", message: { role: "assistant" } });
  usage.observe({
    ...end,
    message: { ...end.message, usage: { ...end.message.usage, output: 6, totalTokens: 22 } },
  });
  expect(usage.snapshot()).toEqual({
    usage: {
      input_tokens: 20,
      output_tokens: 10,
      cache_read_input_tokens: 10,
      cache_creation_input_tokens: 2,
      total_tokens: 42,
    },
    totalCostUsd: 0.04,
  });
  usage.clear();
  expect(usage.snapshot()).toEqual({});
});
it("never invents missing cost or accepts malformed, negative or overflowing token counters", () => {
  const usage = new PiTurnUsage();
  usage.observe({
    type: "message_update",
    usage: { input: -1, output: 0.5, totalTokens: Infinity, cost: { total: -1 } },
  });
  expect(usage.snapshot()).toEqual({});
  for (let i = 0; i < 2; i++) {
    usage.observe({ type: "message_start", message: { role: "assistant" } });
    usage.observe({ type: "message_update", usage: { input: Number.MAX_SAFE_INTEGER, output: 1 } });
  }
  expect(usage.snapshot()).toEqual({ usage: { output_tokens: 2 } });
});
it("uses authoritative context occupancy independently from cumulative billable totals", () => {
  expect(
    piContextUsage({
      tokens: { input: 1_000_000 },
      contextUsage: { tokens: 42, contextWindow: 128_000 },
    }),
  ).toEqual({ contextTokens: 42, modelContextWindowTokens: 128_000 });
  expect(piContextUsage({ contextUsage: { tokens: -1, contextWindow: 0 } })).toBeUndefined();
});
