import { ThreadId, type ThreadSearchInput, type ThreadSearchResult } from "@t3tools/contracts";
import { page, userEvent } from "vitest/browser";
import { beforeEach, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { ThreadFindBar } from "./ThreadFindBar";

const api = vi.hoisted(() => ({
  searchThread: vi.fn<(input: ThreadSearchInput) => Promise<ThreadSearchResult>>(),
}));
vi.mock("../../nativeApi", () => ({ ensureNativeApi: () => ({ orchestration: api }) }));
const threadId = ThreadId.makeUnsafe("find-browser-thread");
const result = (index = 0): ThreadSearchResult => ({
  totalMatches: 2,
  activeIndex: index,
  match: {
    entryId: `message-${index}`,
    kind: "message",
    occurrence: 0,
    snippet: `matched text ${index}`,
  },
});
beforeEach(() => {
  api.searchThread.mockReset();
  api.searchThread.mockImplementation(async (input) => result(input.index ?? 0));
});
it("searches, navigates both directions, wraps and closes without sending", async () => {
  const onMatch = vi.fn(async () => {}),
    onClose = vi.fn();
  await render(<ThreadFindBar threadId={threadId} onMatch={onMatch} onClose={onClose} />);
  await page.getByRole("textbox", { name: "Find in thread" }).fill("matched");
  await expect.element(page.getByRole("status")).toHaveTextContent("1 of 2");
  expect(api.searchThread).toHaveBeenLastCalledWith({ threadId, query: "matched", index: 0 });
  await userEvent.keyboard("{Enter}");
  await expect.element(page.getByRole("status")).toHaveTextContent("2 of 2");
  await page.getByRole("button", { name: "Next match" }).click();
  await expect.element(page.getByRole("status")).toHaveTextContent("1 of 2");
  await page.getByRole("textbox", { name: "Find in thread" }).click();
  await userEvent.keyboard("{Shift>}{Enter}{/Shift}");
  await expect.element(page.getByRole("status")).toHaveTextContent("2 of 2");
  await userEvent.keyboard("{Escape}");
  expect(onClose).toHaveBeenCalledOnce();
  expect(onMatch).toHaveBeenLastCalledWith(
    { ...result(1).match, query: "matched" },
    expect.any(AbortSignal),
  );
});
it("offers retry for search and navigation failures", async () => {
  api.searchThread.mockRejectedValueOnce(new Error("offline"));
  const onMatch = vi.fn(async () => {});
  await render(<ThreadFindBar threadId={threadId} onMatch={onMatch} onClose={() => {}} />);
  await page.getByRole("textbox", { name: "Find in thread" }).fill("matched");
  await expect.element(page.getByRole("status")).toHaveTextContent("Search failed");
  await page.getByRole("button", { name: "Retry" }).click();
  await expect.element(page.getByRole("status")).toHaveTextContent("1 of 2");
  onMatch.mockRejectedValueOnce(new Error("history unavailable"));
  await page.getByRole("button", { name: "Next match" }).click();
  await expect.element(page.getByRole("status")).toHaveTextContent("Search failed");
  await page.getByRole("button", { name: "Retry" }).click();
  await expect.element(page.getByRole("status")).toHaveTextContent("2 of 2");
});
it("ignores responses for a replaced query", async () => {
  let resolveOld!: (value: ThreadSearchResult) => void;
  api.searchThread.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        resolveOld = resolve;
      }),
  );
  const onMatch = vi.fn(async () => {});
  await render(<ThreadFindBar threadId={threadId} onMatch={onMatch} onClose={() => {}} />);
  await page.getByRole("textbox", { name: "Find in thread" }).fill("old");
  await vi.waitFor(() => expect(api.searchThread).toHaveBeenCalledOnce());
  await page.getByRole("textbox", { name: "Find in thread" }).fill("new");
  await expect.element(page.getByRole("status")).toHaveTextContent("1 of 2");
  const calls = onMatch.mock.calls.length;
  resolveOld({ ...result(), totalMatches: 99 });
  await vi.waitFor(() => expect(onMatch).toHaveBeenCalledTimes(calls));
  await expect.element(page.getByRole("status")).toHaveTextContent("1 of 2");
});
