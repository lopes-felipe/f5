import {
  ProjectId,
  ThreadId,
  type NativeApi,
  type ProjectSearchContentsInput,
} from "@t3tools/contracts";
import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";

import * as nativeApi from "../nativeApi";
import {
  projectSearchContentsQueryOptions,
  projectSearchEntriesQueryOptions,
} from "./projectReactQuery";
import { detectComposerTrigger, isPathSuggestionCurrent } from "../composer-logic";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("projectSearchEntriesQueryOptions", () => {
  it("keeps the original search target on placeholder results while another query loads", async () => {
    const searchEntries = vi
      .fn()
      .mockResolvedValueOnce({ entries: [{ path: "alpha.ts", kind: "file" }], truncated: false })
      .mockImplementation(() => new Promise(() => {}));
    vi.spyOn(nativeApi, "ensureNativeApi").mockReturnValue({
      projects: { searchEntries },
    } as unknown as NativeApi);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const initial = projectSearchEntriesQueryOptions({ cwd: "/repo", query: "alpha" });
    await client.fetchQuery(initial);
    const observer = new QueryObserver(client, initial);
    const unsubscribe = observer.subscribe(() => {});
    try {
      for (const target of [
        { cwd: "/repo", query: "beta" },
        { cwd: "/other", query: "alpha" },
      ]) {
        observer.setOptions(projectSearchEntriesQueryOptions(target));
        const result = observer.getCurrentResult();
        expect(result.isPlaceholderData).toBe(true);
        expect(result.data?.searchedTarget).toEqual({ cwd: "/repo", query: "alpha" });
        const text = "@" + target.query;
        expect(
          isPathSuggestionCurrent(
            result.data!.searchedTarget,
            detectComposerTrigger(text, text.length),
            target.cwd,
          ),
        ).toBe(false);
      }
    } finally {
      unsubscribe();
      client.clear();
    }
  });
});

describe("projectSearchContentsQueryOptions", () => {
  it("propagates TanStack cancellation to the server request", async () => {
    let rejectSearch: ((cause: Error) => void) | undefined;
    const searchContents = vi.fn(
      (_input: ProjectSearchContentsInput) =>
        new Promise<never>((_resolve, reject) => {
          rejectSearch = reject;
        }),
    );
    const cancelContentSearch = vi.fn(async () => {
      rejectSearch?.(new DOMException("cancelled", "AbortError"));
      return { cancelled: true };
    });
    vi.spyOn(nativeApi, "ensureNativeApi").mockReturnValue({
      projects: { searchContents, cancelContentSearch },
    } as unknown as NativeApi);

    const options = projectSearchContentsQueryOptions({
      projectId: ProjectId.makeUnsafe("project-content-search"),
      threadId: ThreadId.makeUnsafe("thread-content-search"),
      query: "needle",
    });
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const pending = queryClient.fetchQuery(options);
    await vi.waitFor(() => expect(searchContents).toHaveBeenCalledOnce());
    const requestId = searchContents.mock.calls[0]?.[0].requestId;

    await queryClient.cancelQueries({ queryKey: options.queryKey });
    await pending.catch(() => undefined);

    expect(cancelContentSearch).toHaveBeenCalledWith({ requestId });
  });
});
