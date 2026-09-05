import { expect, it } from "vitest";
import type { CodexControlClient } from "../codex/CodexControlClient.ts";
import { readCodexAccountSections } from "./codexAccountUsage.ts";

it("preserves token success when the independent rate-limit RPC times out", async () => {
  const client = {
    readAccountTokenUsage: async () => ({ summary: {}, dailyUsageBuckets: [] }),
    readAccountRateLimits: () => new Promise(() => {}),
  } as unknown as CodexControlClient;
  const sections = await readCodexAccountSections(client, 10);
  expect(sections[0]).toMatchObject({
    kind: "codex-tokens",
    outcome: "available",
    snapshot: { data: { dailyUsageBuckets: [] } },
  });
  expect(sections[1]).toMatchObject({
    kind: "codex-limits",
    outcome: "unavailable",
    errorCode: "timeout",
    snapshot: null,
  });
});
