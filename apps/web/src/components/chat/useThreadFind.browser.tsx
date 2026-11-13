import { ThreadId } from "@t3tools/contracts";
import { expect, it, vi } from "vitest";
import { renderHook } from "vitest-browser-react";

import type { ThreadFindMatch } from "./ThreadFindBar";
import { useThreadFind } from "./useThreadFind";

const threadA = ThreadId.make("thread-a");
const threadB = ThreadId.make("thread-b");
const needle: ThreadFindMatch = {
  entryId: "message-1",
  kind: "message",
  occurrence: 2,
  snippet: "a needle in the thread",
  query: "needle",
};

/** The hook over a timeline navigation that hands out request ids 1, 2, 3 and records its calls. */
const mount = async () => {
  let nextId = 0;
  const navigation = {
    navigate: vi.fn(() => ++nextId),
    cancelRequest: vi.fn(),
    retry: vi.fn<() => { previousId: number; id: number } | null>(() => null),
    handleSelectedRange: vi.fn(),
  };
  const hook = await renderHook(
    (props?: { threadId: ThreadId }) =>
      useThreadFind({ threadId: props?.threadId ?? threadA, navigation }),
    { initialProps: { threadId: threadA } },
  );
  return { navigation, hook };
};

it("opens for its own thread, from the button or the app-wide find event", async () => {
  const { hook } = await mount();
  expect(hook.result.current.openThreadId).toBeNull();

  await hook.act(() =>
    window.dispatchEvent(new CustomEvent("f5:find-thread", { detail: threadB })),
  );
  expect(hook.result.current.openThreadId).toBeNull();

  await hook.act(() =>
    window.dispatchEvent(new CustomEvent("f5:find-thread", { detail: threadA })),
  );
  expect(hook.result.current.openThreadId).toBe(threadA);

  await hook.act(() => hook.result.current.close());
  expect(hook.result.current.openThreadId).toBeNull();
  await hook.act(() => hook.result.current.open());
  expect(hook.result.current.openThreadId).toBe(threadA);
});

it("jumps to a match, highlights it, and withdraws the jump when the search is aborted", async () => {
  const { navigation, hook } = await mount();
  const search = new AbortController();
  await hook.act(() => hook.result.current.selectMatch(threadA, needle, search.signal));

  expect(navigation.navigate).toHaveBeenCalledWith("message-1", {
    load: true,
    position: 0.3,
    placeRange: true,
  });
  expect(hook.result.current.match).toEqual(needle);
  expect(hook.result.current.contextValue).toEqual({
    entryId: "message-1",
    query: "needle",
    occurrence: 2,
    requestId: 1,
    onSelectedRange: navigation.handleSelectedRange,
  });

  search.abort();
  expect(navigation.cancelRequest).toHaveBeenCalledWith(1);
});

it("ignores a result from a search that was already aborted", async () => {
  const { navigation, hook } = await mount();
  const search = new AbortController();
  search.abort();
  await hook.act(() => hook.result.current.selectMatch(threadA, needle, search.signal));
  expect(navigation.navigate).not.toHaveBeenCalled();
  expect(hook.result.current.match).toBeNull();
});

it("moves the active match to the new request when its jump is retried", async () => {
  const { navigation, hook } = await mount();
  const search = new AbortController();
  await hook.act(() => hook.result.current.selectMatch(threadA, needle, search.signal));

  navigation.retry.mockReturnValueOnce({ previousId: 1, id: 7 });
  await hook.act(() => hook.result.current.retryNavigation());
  expect(hook.result.current.contextValue?.requestId).toBe(7);

  // Closing the bar and aborting the search both withdraw the retried request, not the old one.
  await hook.act(() => hook.result.current.close());
  search.abort();
  expect(navigation.cancelRequest.mock.calls).toEqual([[7], [7]]);
  expect(hook.result.current.match).toBeNull();
});

it("leaves a retry of some other jump alone", async () => {
  const { navigation, hook } = await mount();
  await hook.act(() =>
    hook.result.current.selectMatch(threadA, needle, new AbortController().signal),
  );
  navigation.retry.mockReturnValueOnce({ previousId: 5, id: 6 });
  await hook.act(() => hook.result.current.retryNavigation());
  expect(hook.result.current.contextValue?.requestId).toBe(1);
});

it("clears the match and cancels its jump when the search finds nothing", async () => {
  const { navigation, hook } = await mount();
  const signal = new AbortController().signal;
  await hook.act(() => hook.result.current.selectMatch(threadA, needle, signal));
  await hook.act(() => hook.result.current.selectMatch(threadA, null, signal));
  expect(navigation.cancelRequest).toHaveBeenCalledWith(1);
  expect(hook.result.current.match).toBeNull();
  expect(hook.result.current.contextValue).toBeNull();
});

it("shows neither the bar's match nor its highlight on another thread", async () => {
  const { hook } = await mount();
  await hook.act(() => hook.result.current.open());
  await hook.act(() =>
    hook.result.current.selectMatch(threadA, needle, new AbortController().signal),
  );

  await hook.rerender({ threadId: threadB });
  expect(hook.result.current.match).toBeNull();
  expect(hook.result.current.contextValue).toBeNull();
  // The caller compares this with the thread it renders, so the bar stays closed there.
  expect(hook.result.current.openThreadId).toBe(threadA);

  await hook.rerender({ threadId: threadA });
  expect(hook.result.current.match).toEqual(needle);
});
