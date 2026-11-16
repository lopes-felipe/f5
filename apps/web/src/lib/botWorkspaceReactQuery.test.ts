import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";

import {
  botWorkspaceQueryKeys,
  describeContact,
  refreshBotWorkspace,
} from "./botWorkspaceReactQuery";

describe("describeContact", () => {
  const now = Date.parse("2026-10-15T12:00:00.000Z");

  it("describes freshness without implying a status change", () => {
    expect(describeContact(null, now)).toBe("No contact yet");
    expect(describeContact("2026-10-15T11:59:30.000Z", now)).toBe("Last contact just now");
    expect(describeContact("2026-10-15T11:45:00.000Z", now)).toBe("Last contact 15 min ago");
    expect(describeContact("2026-10-15T09:00:00.000Z", now)).toBe("Last contact 3 h ago");
    expect(describeContact("2026-10-12T12:00:00.000Z", now)).toBe("Last contact 3 d ago");
  });
});

describe("refreshBotWorkspace", () => {
  it("restarts a first load that predates the invalidation", async () => {
    const queryClient = new QueryClient();
    let calls = 0;
    const resolvers: Array<(value: number) => void> = [];
    const first = queryClient.fetchQuery({
      queryKey: botWorkspaceQueryKeys.task("t1"),
      queryFn: () => {
        calls += 1;
        return new Promise<number>((resolve) => resolvers.push(resolve));
      },
    });
    await refreshBotWorkspace(queryClient);
    await expect(first).rejects.toThrow();
    expect(queryClient.getQueryState(botWorkspaceQueryKeys.task("t1"))?.fetchStatus).toBe("idle");
    expect(calls).toBe(1);
  });
});
