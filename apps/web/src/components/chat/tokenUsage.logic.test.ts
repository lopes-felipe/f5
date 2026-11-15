import { TurnId, type UsageThreadTurn } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";
import { formatUsageTokens, turnTokenUsage } from "./tokenUsage.logic";

const turn = (overrides: Partial<UsageThreadTurn>): UsageThreadTurn => ({
  turnId: TurnId.makeUnsafe("turn"),
  provider: "codex",
  model: "gpt-6.1",
  completedAt: "2026-11-14T12:00:00Z",
  inputTokens: 1000,
  outputTokens: 100,
  cacheReadTokens: 800,
  cacheWriteTokens: 50,
  ...overrides,
});

describe("turn token accounting", () => {
  it("does not double count Codex cache reads or reasoning", () => {
    expect(turnTokenUsage(turn({}))).toMatchObject({ input: 1000, total: 1100, partial: false });
  });
  it("adds separately reported Claude cache fields once", () => {
    expect(turnTokenUsage(turn({ provider: "claudeAgent" }))).toMatchObject({
      input: 1850,
      total: 1950,
      partial: false,
    });
  });
  it("prefers a reported total even when its components are missing", () => {
    expect(
      turnTokenUsage(
        turn({ inputTokens: null, totalTokens: 42, tokenProvenance: "provider-reported" }),
      ),
    ).toMatchObject({ total: 42, partial: false });
  });
  it("distinguishes zero, partial and missing usage", () => {
    expect(turnTokenUsage(turn({ inputTokens: 0, outputTokens: 0 })).total).toBe(0);
    expect(turnTokenUsage(turn({ outputTokens: null }))).toMatchObject({
      total: 1000,
      partial: true,
    });
    expect(turnTokenUsage(turn({ inputTokens: null, outputTokens: null })).total).toBeNull();
  });
  it.each([
    [12400, "12.4k"],
    [1e6, "1M"],
    [1e9, "1B"],
  ])("formats %s as %s", (value, expected) => {
    expect(formatUsageTokens(value)).toBe(expected);
  });
});
