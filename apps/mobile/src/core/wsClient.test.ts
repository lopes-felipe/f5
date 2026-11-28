import { afterEach, expect, it, vi } from "vitest";
import fixtures from "../../../../packages/contracts/src/mobile/fixtures/v1/wire.json";
import { connectMobile, readMobileShell } from "./wsClient";
import { decodeMobileTail } from "./decode";

const paired = {
  ...fixtures.pair.response,
  origins: ["http://100.64.1.2:37730"],
  deviceName: "Phone",
};
afterEach(() => vi.unstubAllGlobals());

it.each([
  ["starting", "code", "starting"],
  ["disabled", "state", "access-off"],
])("preserves the pairing on a %s shell response", async (error, field, value) => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ error }, { status: 503 })));
  await expect(
    readMobileShell(paired.origins[0]!, paired, "incarnation", new AbortController().signal),
  ).rejects.toMatchObject({ [field]: value });
});

it("retries a replaced backend without classifying the paired server as a different identity", async () => {
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(Response.json(fixtures.status))
    .mockResolvedValueOnce(Response.json(fixtures.bootstrap));
  vi.stubGlobal("fetch", fetch);
  let socket!: FakeSocket;
  class FakeSocket {
    onmessage?: (event: { data: string }) => void;
    close = vi.fn();
    constructor() {
      socket = this;
    }
  }
  vi.stubGlobal("WebSocket", FakeSocket);
  const pending = connectMobile(paired, new AbortController().signal, {
    push: vi.fn(),
    disconnected: vi.fn(),
  });
  await vi.waitFor(() => expect(socket?.onmessage).toBeTypeOf("function"));
  socket.onmessage?.({
    data: JSON.stringify({
      channel: "mobile.welcome",
      body: { ...fixtures.bootstrap, backendIncarnation: "restarted" },
    }),
  });
  await expect(pending).rejects.toMatchObject({ state: "offline" });
});

it("ignores additive approval choices and keeps unknown question modes on the host", () => {
  const tail = fixtures.methods.getThreadTail.response;
  const value = decodeMobileTail({
    ...tail,
    approvals: tail.approvals.map((approval) => ({
      ...approval,
      decisions: [...approval.decisions, "future"],
      nestedField: true,
    })),
    pendingInputs: [
      { requestId: "future", hostOnly: false, responseMode: "future", questions: [] },
    ],
  });
  expect(value.approvals).toEqual(tail.approvals);
  expect(value.pendingInputs[0]).toMatchObject({ hostOnly: true, questions: [] });
});
