import { beforeEach, expect, it, vi } from "vitest";
import { ThreadId } from "@t3tools/contracts";
import { openNewSideChat } from "./sideChats";

const fixture = vi.hoisted(() => ({
  threads: [] as Array<Record<string, unknown>>,
  fork: vi.fn(),
  list: vi.fn(),
  open: vi.fn(),
  send: vi.fn(async () => "started"),
  draft: vi.fn(),
}));
vi.mock("../store", () => ({ useStore: { getState: () => ({ threads: fixture.threads }) } }));
vi.mock("../nativeApi", () => ({
  ensureNativeApi: () => ({ nativeOperations: { fork: fixture.fork, list: fixture.list } }),
}));
vi.mock("../rightPanelStore", () => ({
  useRightPanelStore: { getState: () => ({ openSideChat: fixture.open }) },
}));
vi.mock("../composerDraftStore", () => ({
  useComposerDraftStore: { getState: () => ({ setPrompt: fixture.draft }) },
}));
vi.mock("./sendThreadReply", () => ({ sendThreadReply: fixture.send }));
const parent = ThreadId.makeUnsafe("parent");
beforeEach(() => {
  vi.clearAllMocks();
  fixture.threads = [{ id: parent, title: "Main", session: { capabilities: { generation: 7 } } }];
  fixture.fork.mockImplementation(async (input) => {
    fixture.threads.push({ id: "fork-" + input.operationId, sideChatOf: parent, title: "Side" });
    return { ...input, state: "completed" };
  });
});
it("forks once, opens the tab and sends the question to the child", async () => {
  const first = openNewSideChat(parent, "What does this function do?");
  expect(openNewSideChat(parent)).toBe(first);
  const child = await first;
  expect(fixture.fork).toHaveBeenCalledOnce();
  expect(fixture.fork).toHaveBeenCalledWith(
    expect.objectContaining({ threadId: parent, sideChat: true, generation: 7 }),
  );
  expect(fixture.open).toHaveBeenCalledWith(parent, child, "Side chat");
  expect(fixture.send).toHaveBeenCalledWith(
    expect.objectContaining({
      thread: expect.objectContaining({ id: child }),
      text: "What does this function do?",
    }),
  );
});
it("reports refused forks without opening a tab or sending text", async () => {
  fixture.fork.mockResolvedValueOnce({ state: "failed", error: "unsupported" });
  await expect(openNewSideChat(parent, "question")).rejects.toThrow("unsupported");
  expect(fixture.open).not.toHaveBeenCalled();
  expect(fixture.send).not.toHaveBeenCalled();
});
it("refuses nested side chats", async () => {
  fixture.threads[0]!.sideChatOf = "another";
  await expect(openNewSideChat(parent)).rejects.toThrow("main thread");
  expect(fixture.fork).not.toHaveBeenCalled();
});
