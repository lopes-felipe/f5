import { expect, it } from "vitest";
import { ThreadId } from "@t3tools/contracts";
import { useFreshSessionStore } from "./freshSessionStore";
it("consumes only the arm captured by an admitted send", () => {
  const id = ThreadId.makeUnsafe("thread");
  const store = useFreshSessionStore.getState();
  store.arm(id);
  const old = useFreshSessionStore.getState().arms[id]!;
  store.arm(id);
  store.consume(id, old);
  expect(useFreshSessionStore.getState().arms[id]).not.toBe(old);
  store.consume(id, useFreshSessionStore.getState().arms[id]!);
  expect(useFreshSessionStore.getState().arms[id]).toBeUndefined();
});
