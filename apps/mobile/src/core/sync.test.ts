import { afterEach, expect, it, vi } from "vitest";
import fixtures from "../../../../packages/contracts/src/mobile/fixtures/v1/wire.json";
import { useMobileModel } from "./model";
import { mobileSync } from "./sync";

const mocks = vi.hoisted(() => ({
  connect: vi.fn(),
  shell: vi.fn(),
  rpc: vi.fn(),
}));
vi.mock("./storage", () => ({ readPairedServer: vi.fn(), writePairedServer: vi.fn() }));
vi.mock("./wsClient", async (original) => ({
  ...(await original<typeof import("./wsClient")>()),
  connectMobile: mocks.connect,
  readMobileShell: mocks.shell,
}));

const threadId = "thread-fixture";
const paired = {
  ...fixtures.pair.response,
  origins: ["http://100.64.1.2:37730"],
  deviceName: "Phone",
};
const message = fixtures.methods.getThreadTail.response.messages[0]!;
const history = fixtures.methods.getThreadHistory.response;
const shell = { ...fixtures.methods.getThreadShells.response, snapshotSequence: 10 };
const tail = {
  ...fixtures.methods.getThreadTail.response,
  snapshotSequence: 10,
  hasOlderMessages: true,
};

afterEach(async () => {
  await mobileSync.setServer(null);
  vi.resetAllMocks();
});

it("reuses the shell on selection and discards a history page racing a rewind and tail refresh", async () => {
  const oldPage = Promise.withResolvers<unknown>();
  const preservingTail = Promise.withResolvers<unknown>();
  let push!: (channel: string, body: unknown) => void;
  mocks.connect.mockImplementation(async (_server, _signal, handlers) => {
    push = handlers.push;
    return { origin: paired.origins[0], welcome: fixtures.bootstrap, rpc: mocks.rpc };
  });
  mocks.shell.mockResolvedValue(shell);
  let tailReads = 0;
  mocks.rpc.mockImplementation(async (method, body) => {
    switch (method) {
      case "subscribe":
        return { head: 10, snapshotRequired: !body.resume, batches: [] };
      case "getThreadTail":
        if (++tailReads === 1) return tail;
        if (tailReads === 2) return preservingTail.promise;
        return { ...tail, snapshotSequence: 12, hasOlderMessages: false, messages: [] };
      case "getThreadHistory":
        return oldPage.promise;
      default:
        throw new Error("Unexpected RPC " + method);
    }
  });
  const model = useMobileModel.getState;
  await mobileSync.setServer(paired);
  await vi.waitFor(() => expect(model().status).toBe("ready"));
  mobileSync.select(threadId);
  await vi.waitFor(() => expect(model().details.get(threadId)?.messages).toHaveLength(1));
  await vi.waitFor(() => expect(model().stale).toBe(false));
  expect(mocks.shell).toHaveBeenCalledTimes(1);

  // Load an older row into the window so a preserving refresh has something to discard.
  const oldMessage = { ...message, messageId: "old", createdAt: "2025-01-01T00:00:00.000Z" };
  oldPage.resolve({
    ...history,
    messages: [oldMessage],
    cursor: { createdAt: oldMessage.createdAt, messageId: oldMessage.messageId },
  });
  await mobileSync.history(threadId);
  expect(model().details.get(threadId)?.messages).toHaveLength(2);
  const latePage = Promise.withResolvers<unknown>();
  mocks.rpc.mockImplementationOnce(async () => latePage.promise);
  const loading = mobileSync.history(threadId);

  const batch = {
    afterSequence: 10,
    throughSequence: 11,
    selectedThreadId: threadId,
    messages: [],
    threadIds: [],
    projectsChanged: false,
    tailInvalidated: true,
    transcriptReset: false,
  };
  push("mobile.batch", batch);
  await vi.waitFor(() => expect(tailReads).toBe(2));
  push("mobile.batch", { ...batch, afterSequence: 11, throughSequence: 12, transcriptReset: true });
  latePage.resolve({ ...history, messages: [{ ...oldMessage, messageId: "discarded" }] });
  await loading;
  expect(
    model()
      .details.get(threadId)
      ?.messages.map(({ messageId }) => messageId),
  ).not.toContain("discarded");
  preservingTail.resolve({ ...tail, snapshotSequence: 12, hasOlderMessages: false, messages: [] });
  await vi.waitFor(() => {
    expect(model().details.get(threadId)?.cursor).toBeNull();
    expect(model().details.get(threadId)?.messages).toEqual([]);
    expect(model().stale).toBe(false);
  });
});
