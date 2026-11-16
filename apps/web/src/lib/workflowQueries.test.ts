import type { OrchestrationEvent } from "@t3tools/contracts";
import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { expect, it } from "vitest";
import { invalidateWorkflowQueries, workflowDetailsQueryKey } from "./workflowQueries";

it("refreshes omitted run details even when summary identity/timestamp stay unchanged", async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const key = workflowDetailsQueryKey("planning", "run");
  let calls = 0;
  let finishOld!: (value: string) => void;
  const observer = new QueryObserver(client, {
    queryKey: key,
    staleTime: Infinity,
    queryFn: () =>
      ++calls === 1
        ? new Promise<string>((resolve) => {
            finishOld = resolve;
          })
        : Promise.resolve("new detail"),
  });
  const unsubscribe = observer.subscribe(() => {});
  try {
    expect(calls).toBe(1);
    const event = {
      type: "project.workflow-upserted",
      payload: { workflow: { id: "run", updatedAt: "same" } },
    } as unknown as OrchestrationEvent;
    await invalidateWorkflowQueries(client, [event, event]);
    expect(client.getQueryData(key)).toBe("new detail");
    finishOld("old detail");
    await Promise.resolve();
    expect(client.getQueryData(key)).toBe("new detail");
    expect(calls).toBe(2);
    expect(client.getQueryCache().getAll()).toHaveLength(1);
  } finally {
    unsubscribe();
    client.clear();
  }
});
