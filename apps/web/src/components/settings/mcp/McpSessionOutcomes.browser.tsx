import "../../../index.css";
import {
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type McpSessionReloadOutcome,
} from "@t3tools/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";

import { McpSessionOutcomes } from "./McpSessionOutcomes";

const mocks = vi.hoisted(() => ({
  reconnectServer: vi.fn(),
}));
vi.mock("../../../nativeApi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../nativeApi")>()),
  ensureNativeApi: () => ({ mcp: { reconnectServer: mocks.reconnectServer } }),
}));

const instanceId = ProviderInstanceId.makeUnsafe("codex");
function outcome(
  thread: string,
  disposition: McpSessionReloadOutcome["disposition"],
): McpSessionReloadOutcome {
  return {
    threadId: ThreadId.makeUnsafe(thread),
    instanceId,
    generation: 1,
    requestedVersion: "v1",
    attemptedVersion: "v1",
    disposition,
    result: {
      converged: disposition === "applied",
      restartRequired: false,
      servers: [],
      errors: [],
    },
  };
}

describe("McpSessionOutcomes", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("updates only the retried conversation and yields to the next parent result", async () => {
    const queryClient = new QueryClient();
    mocks.reconnectServer.mockResolvedValue({ sessions: [outcome("thread-a", "applied")] });
    const view = (outcomes: ReadonlyArray<McpSessionReloadOutcome>) => (
      <QueryClientProvider client={queryClient}>
        <McpSessionOutcomes
          outcomes={outcomes}
          action="reconnect"
          projectId={ProjectId.makeUnsafe("project")}
          instanceId={instanceId}
          serverName="docs"
        />
      </QueryClientProvider>
    );
    const screen = await render(
      view([outcome("thread-a", "failed"), outcome("thread-b", "failed")]),
    );
    try {
      const retries = page.getByRole("button", { name: "Retry in this conversation" });
      expect(retries.elements()).toHaveLength(2);
      await retries.first().click();
      await expect.element(page.getByText("thread-a · generation 1: applied")).toBeVisible();
      // The other failure keeps its row and its retry.
      await expect.element(page.getByText("thread-b · generation 1: failed")).toBeVisible();
      expect(retries.elements()).toHaveLength(1);

      // A new Apply or Reconnect result replaces the retried rows.
      await screen.rerender(view([outcome("thread-a", "deferred")]));
      await expect.element(page.getByText("thread-a · generation 1: deferred")).toBeVisible();
    } finally {
      queryClient.clear();
      await screen.unmount();
    }
  });
});
