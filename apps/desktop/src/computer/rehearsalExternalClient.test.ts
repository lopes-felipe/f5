import { afterEach, expect, it, vi } from "vitest";
import { NextTurnQueueSubmitInput, ORCHESTRATION_WS_METHODS, WS_METHODS } from "@t3tools/contracts";
import { Schema } from "effect";
import { RehearsalExternalClient } from "./rehearsalExternalClient";

class TestSocket extends EventTarget {
  sent: string[] = [];
  closed = false;
  send(value: string | ArrayBufferLike | Blob | ArrayBufferView) {
    this.sent.push(String(value));
  }
  close() {
    this.closed = true;
    this.dispatchEvent(new Event("close"));
  }
  message(value: unknown) {
    this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(value) }));
  }
}
afterEach(() => vi.useRealTimers());
async function connected(timeoutMs = 15000) {
  const socket = new TestSocket();
  const connecting = RehearsalExternalClient.connect(
    "ws://127.0.0.1:1234/?token=PRIVATE_TOKEN",
    () => {},
    {
      createSocket: () => socket,
      timeoutMs,
    },
  );
  socket.message({ channel: "server.welcome", data: {} });
  return { client: await connecting, socket };
}
it.each([
  "wss://127.0.0.1:1",
  "ws://remote.example:1",
  "ws://localhost:1",
  "ws://127.0.0.1:1/nonlocal-path",
  "ws://user:PRIVATE_TOKEN@127.0.0.1:1",
  "not-a-url",
])("rejects nonlocal or ambiguous authentication URLs without echoing credentials", async (url) => {
  const createSocket = vi.fn();
  await expect(
    RehearsalExternalClient.connect(url, () => {}, { createSocket }),
  ).rejects.toMatchObject({ outcome: "Unavailable" });
  expect(createSocket).not.toHaveBeenCalled();
});
it("waits for the real protocol welcome before accepting requests", async () => {
  vi.useFakeTimers();
  const socket = new TestSocket();
  const failed = expect(
    RehearsalExternalClient.connect("ws://127.0.0.1:1", () => {}, {
      createSocket: () => socket,
      timeoutMs: 10,
    }),
  ).rejects.toMatchObject({ outcome: "Unavailable" });
  await vi.advanceTimersByTimeAsync(11);
  await failed;
  expect(socket.sent).toEqual([]);
  expect(socket.closed).toBe(true);
});
it("correlates read replies without allowing a body to override the method", async () => {
  const { client, socket } = await connected();
  const reply = client.rpc(ORCHESTRATION_WS_METHODS.getSnapshot, { _tag: "computer.execute" });
  const sent = JSON.parse(socket.sent[0]!);
  expect(sent.body._tag).toBe(ORCHESTRATION_WS_METHODS.getSnapshot);
  socket.message({ id: sent.id, result: { threads: [] } });
  expect(await reply).toEqual({ threads: [] });
  client.close();
});
it("does not expose grants, leases, execution, consent answers or settings changes", async () => {
  const { client, socket } = await connected();
  for (const method of [
    "computer.execute",
    "computer.access.answer",
    "computer.lease.acquire",
    "server.settings.update",
  ])
    await expect(client.rpc(method)).rejects.toMatchObject({ outcome: "Unavailable" });
  await expect(
    client.rpc(ORCHESTRATION_WS_METHODS.dispatchCommand, {
      command: { type: "thread.runtime-mode.set" },
    }),
  ).rejects.toMatchObject({ outcome: "Unavailable" });
  expect(socket.sent).toEqual([]);
  client.close();
});
const queuedTurn = () => ({
  submissionId: "windowless-submission",
  intent: "auto",
  command: {
    type: "thread.turn.start",
    commandId: "windowless-command",
    threadId: "windowless-thread",
    message: {
      messageId: "windowless-message",
      role: "user",
      text: "Synthetic check",
      attachments: [],
    },
    runtimeMode: "full-access",
    interactionMode: "default",
    createdAt: "2026-10-14T00:00:00.000Z",
  },
});
it("submits an established-thread turn through the ordinary queue exactly once", async () => {
  const { client, socket } = await connected();
  const input = queuedTurn();
  expect(Schema.is(NextTurnQueueSubmitInput)(input)).toBe(true);
  const reply = client.rpc(WS_METHODS.nextTurnQueueSubmit, input);
  // Attach before any awaited work so a refusal is handled by the assertion.
  const settled = reply.then(
    (value) => ({ value }),
    (error) => ({ error }),
  );
  await Promise.resolve();
  expect(socket.sent).toHaveLength(1);
  const request = JSON.parse(socket.sent[0]!);
  expect(request.body).toEqual({ ...input, _tag: WS_METHODS.nextTurnQueueSubmit });
  socket.message({
    id: request.id,
    result: { disposition: "started", submissionId: input.submissionId, sequence: 1 },
  });
  expect(await settled).toEqual({
    value: { disposition: "started", submissionId: input.submissionId, sequence: 1 },
  });
  client.close();
});
it("refuses direct turn dispatch and queue bootstrap or ordering overrides", async () => {
  const { client, socket } = await connected();
  await expect(
    client.rpc(ORCHESTRATION_WS_METHODS.dispatchCommand, { command: queuedTurn().command }),
  ).rejects.toMatchObject({ outcome: "Unavailable" });
  for (const input of [
    { ...queuedTurn(), intent: "queue-head" },
    { ...queuedTurn(), command: { ...queuedTurn().command, bootstrap: {} } },
    { ...queuedTurn(), command: { ...queuedTurn().command, dispatchSource: "next-turn-queue" } },
    { ...queuedTurn(), command: { ...queuedTurn().command, runtimeMode: "invalid" } },
  ])
    await expect(client.rpc(WS_METHODS.nextTurnQueueSubmit, input)).rejects.toMatchObject({
      outcome: "Unavailable",
    });
  expect(socket.sent).toEqual([]);
  client.close();
});
it("never resubmits an ambiguous queued turn", async () => {
  const { client, socket } = await connected();
  const input = queuedTurn();
  const failed = expect(client.rpc(WS_METHODS.nextTurnQueueSubmit, input)).rejects.toMatchObject({
    outcome: "OutcomeUnknown",
  });
  expect(socket.sent).toHaveLength(1);
  socket.close();
  await failed;
  await expect(client.rpc(WS_METHODS.nextTurnQueueSubmit, input)).rejects.toMatchObject({
    outcome: "Unavailable",
  });
  expect(socket.sent).toHaveLength(1);
});
it("reports a lost dispatch as unknown, fails observations and never retries", async () => {
  const { client, socket } = await connected();
  const write = expect(
    client.rpc(ORCHESTRATION_WS_METHODS.dispatchCommand, {
      command: { type: "thread.session.stop" },
    }),
  ).rejects.toMatchObject({ outcome: "OutcomeUnknown" });
  const read = expect(client.rpc(ORCHESTRATION_WS_METHODS.getSnapshot)).rejects.toMatchObject({
    outcome: "Interrupted",
  });
  socket.close();
  await Promise.all([write, read]);
  expect(socket.sent).toHaveLength(2);
  await expect(
    client.rpc(ORCHESTRATION_WS_METHODS.dispatchCommand, {
      command: { type: "thread.session.stop" },
    }),
  ).rejects.toMatchObject({ outcome: "Unavailable" });
  expect(socket.sent).toHaveLength(2);
});
it("latches a dispatch timeout and removes private provider errors", async () => {
  vi.useFakeTimers();
  const { client, socket } = await connected(10);
  const write = expect(
    client.rpc(ORCHESTRATION_WS_METHODS.dispatchCommand, {
      command: { type: "thread.session.stop" },
    }),
  ).rejects.toMatchObject({ outcome: "OutcomeUnknown" });
  await vi.advanceTimersByTimeAsync(11);
  await write;
  expect(socket.closed).toBe(true);
  const next = await connected();
  const read = next.client.rpc(ORCHESTRATION_WS_METHODS.getSnapshot);
  next.socket.message({
    id: JSON.parse(next.socket.sent[0]!).id,
    error: { message: "PRIVATE_PROVIDER_SENTINEL" },
  });
  await expect(read).rejects.toThrow("External rehearsal transport Unavailable");
  next.client.close();
});
