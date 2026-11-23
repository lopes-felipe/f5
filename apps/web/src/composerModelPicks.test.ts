import { ThreadId } from "@t3tools/contracts";
import { expect, it, vi } from "vitest";
import { pendingComposerModelPick, queueComposerModelPick } from "./composerModelPicks";

it("queues picks in order and leaves other threads free to send", async () => {
  const thread = ThreadId.makeUnsafe("test-thread");
  const otherThread = ThreadId.makeUnsafe("other-thread");
  let rejectFirst!: (error: Error) => void;
  const first = new Promise<void>((_resolve, reject) => {
    rejectFirst = reject;
  });
  const save = vi.fn(async () => {});
  const send = vi.fn();
  const firstPick = queueComposerModelPick(thread, () => first);
  const secondPick = queueComposerModelPick(thread, save);
  const nextTurn = pendingComposerModelPick(thread)?.then(send);
  await queueComposerModelPick(otherThread, async () => {});
  expect(save).not.toHaveBeenCalled();
  expect(send).not.toHaveBeenCalled();
  rejectFirst(new Error("First pick failed"));
  await expect(firstPick).rejects.toThrow("First pick failed");
  await secondPick;
  await nextTurn;
  expect(save).toHaveBeenCalledOnce();
  expect(send).toHaveBeenCalledOnce();
  expect(pendingComposerModelPick(thread)).toBeUndefined();
});

it("lets the next turn proceed when the pending save fails", async () => {
  const thread = ThreadId.makeUnsafe("failed-pick-thread");
  const pick = queueComposerModelPick(thread, async () => {
    throw new Error("offline");
  });
  const send = vi.fn();
  const turn = pendingComposerModelPick(thread)?.then(send);
  await expect(pick).rejects.toThrow("offline");
  await turn;
  expect(send).toHaveBeenCalledOnce();
});
