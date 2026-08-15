import {
  ProjectId,
  ThreadId,
  type NativeApi,
  type ProjectSearchContentsInput,
} from "@t3tools/contracts";
import { QueryClient } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";

import * as nativeApi from "../nativeApi";
import { projectSearchContentsQueryOptions } from "./projectReactQuery";

afterEach(() => {
  vi.restoreAllMocks();
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
