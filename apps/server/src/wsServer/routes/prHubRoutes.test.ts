import { PR_HUB_WS_METHODS } from "@t3tools/contracts";
import { Cause, Effect, Exit, Option } from "effect";
import { describe, expect, it, vi } from "vitest";
import type { WebSocket } from "ws";

import { prHubRoutes } from "./prHubRoutes.ts";

const fakeWs = {} as WebSocket;

describe("prHubRoutes", () => {
  it("fails cleanly when forgeAccounts or prHubExtensions are absent", async () => {
    const listPullRequests = vi.fn(() => Effect.succeed({ items: [], nextCursor: null } as never));
    const routes = prHubRoutes({
      prHub: { listPullRequests } as never,
      prHubAdvisory: {} as never,
      prHubReviewGuide: {} as never,
      forgeAccounts: Option.none(),
      prHubExtensions: Option.none(),
      runtime: Effect.die("unused"),
    });

    const accountsExit = await Effect.runPromiseExit(
      routes[PR_HUB_WS_METHODS.listAccounts]({ _tag: PR_HUB_WS_METHODS.listAccounts }, fakeWs),
    );
    expect(Exit.isFailure(accountsExit)).toBe(true);
    if (Exit.isFailure(accountsExit)) {
      expect((Cause.squash(accountsExit.cause) as Error).message).toBe(
        "Forge accounts are unavailable.",
      );
    }

    const cancelExit = await Effect.runPromiseExit(
      routes[PR_HUB_WS_METHODS.cancelOperation](
        { _tag: PR_HUB_WS_METHODS.cancelOperation, operationId: "op-1" } as never,
        fakeWs,
      ),
    );
    expect(Exit.isFailure(cancelExit)).toBe(true);
    if (Exit.isFailure(cancelExit)) {
      expect((Cause.squash(cancelExit.cause) as Error).message).toBe(
        "PR Hub extensions are unavailable.",
      );
    }

    const page = await Effect.runPromise(
      routes[PR_HUB_WS_METHODS.listPullRequests](
        { _tag: PR_HUB_WS_METHODS.listPullRequests } as never,
        fakeWs,
      ),
    );
    expect(page).toEqual({ items: [], nextCursor: null });
  });
});
