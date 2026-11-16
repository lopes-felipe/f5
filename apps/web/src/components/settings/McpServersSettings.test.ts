import { describe, expect, it } from "vitest";

import { describeMcpApplyProblems } from "./McpServersSettings";

describe("describeMcpApplyProblems", () => {
  it("is silent when every session converged", () => {
    expect(
      describeMcpApplyProblems({
        scope: "project",
        codexReloaded: 1,
        claudeRestarted: 0,
        claudeReconciled: 1,
        skipped: 0,
      }),
    ).toBeNull();
  });

  it("reports deferred restarts and per-server errors", () => {
    expect(
      describeMcpApplyProblems({
        scope: "project",
        codexReloaded: 0,
        claudeRestarted: 0,
        deferred: 1,
        skipped: 0,
        failures: [
          { threadId: "t1", provider: "claudeAgent", restartRequired: true, errors: [] },
          {
            threadId: "t2",
            provider: "codex",
            restartRequired: false,
            errors: [{ server: "docs", message: "spawn ENOENT" }],
          },
        ],
      }),
    ).toBe(
      "1 session(s) will restart with the new MCP config at their next turn. 1 session(s) did not fully apply the MCP config (docs: spawn ENOENT).",
    );
  });
});
