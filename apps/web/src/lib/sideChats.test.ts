import { beforeEach, expect, it, vi } from "vitest";
import { ThreadId } from "@t3tools/contracts";
import { openNewSideChat } from "./sideChats";

const fixture = vi.hoisted(() => ({
  threads: [] as Array<Record<string, unknown>>,
  fork: vi.fn(),
  list: vi.fn(),
  open: vi.fn(),
}));
vi.mock("../store", () => ({ useStore: { getState: () => ({ threads: fixture.threads }) } }));
vi.mock("../nativeApi", () => ({
  ensureNativeApi: () => ({ nativeOperations: { fork: fixture.fork, list: fixture.list } }),
}));
vi.mock("../rightPanelStore", () => ({
  useRightPanelStore: { getState: () => ({ openSideChat: fixture.open }) },
}));
const parent = ThreadId.makeUnsafe("parent");
beforeEach(() => {
  vi.clearAllMocks();
  fixture.threads = [{ id: parent, title: "Main", session: { capabilities: { generation: 7 } } }];
  fixture.fork.mockImplementation(async (input) => {
    fixture.threads.push({ id: "fork-" + input.operationId, sideChatOf: parent, title: "Side" });
    return { ...input, state: "completed" };
  });
});
it("shares the fork and opens the tab once", async () => {
  const first = openNewSideChat(parent);
  expect(openNewSideChat(parent)).toBe(first);
  const child = await first;
  expect(fixture.fork).toHaveBeenCalledOnce();
  expect(fixture.fork).toHaveBeenCalledWith(
    expect.objectContaining({ threadId: parent, sideChat: true, generation: 7 }),
  );
  expect(fixture.open).toHaveBeenCalledWith(parent, child, "Side chat");
});
it("reports refused forks without opening a tab", async () => {
  fixture.fork.mockResolvedValueOnce({ state: "failed", error: "unsupported" });
  await expect(openNewSideChat(parent)).rejects.toThrow("unsupported");
  expect(fixture.open).not.toHaveBeenCalled();
});
it("refuses nested side chats", async () => {
  fixture.threads[0]!.sideChatOf = "another";
  await expect(openNewSideChat(parent)).rejects.toThrow("main thread");
  expect(fixture.fork).not.toHaveBeenCalled();
});
