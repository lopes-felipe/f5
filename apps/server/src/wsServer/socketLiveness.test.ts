import { EventEmitter } from "node:events";
import type { WebSocket } from "ws";
import { afterEach, expect, it, vi } from "vitest";
import { closeSocketsWithin, makeSocketLiveness } from "./socketLiveness.ts";
class Socket extends EventEmitter {
  readyState = 1;
  ping = vi.fn();
  close = vi.fn();
  terminate = vi.fn(() => {
    this.readyState = 3;
    this.emit("close");
  });
  asWebSocket() {
    return this as unknown as WebSocket;
  }
}
afterEach(() => vi.useRealTimers());
it("terminates half-open sockets after two missed pongs and keeps responsive sockets alive", async () => {
  vi.useFakeTimers();
  const live = makeSocketLiveness(),
    healthy = new Socket(),
    halfOpen = new Socket();
  live.add(healthy.asWebSocket());
  live.add(halfOpen.asWebSocket());
  healthy.emit("pong");
  await vi.advanceTimersByTimeAsync(30_000);
  healthy.emit("pong");
  await vi.advanceTimersByTimeAsync(30_000);
  expect(halfOpen.terminate).toHaveBeenCalledOnce();
  expect(healthy.terminate).not.toHaveBeenCalled();
  live.dispose();
  expect(healthy.listenerCount("pong")).toBe(0);
  expect(healthy.listenerCount("close")).toBe(0);
  expect(vi.getTimerCount()).toBe(0);
});
it("bounds shutdown when a peer never acknowledges close and releases listeners", async () => {
  vi.useFakeTimers();
  const graceful = new Socket(),
    hanging = new Socket();
  graceful.close.mockImplementation(() => {
    graceful.readyState = 3;
    graceful.emit("close");
  });
  const closing = closeSocketsWithin(
    [graceful.asWebSocket(), hanging.asWebSocket()],
    performance.now() + 100,
  );
  await vi.advanceTimersByTimeAsync(100);
  await closing;
  expect(graceful.terminate).not.toHaveBeenCalled();
  expect(hanging.terminate).toHaveBeenCalledOnce();
  expect(graceful.listenerCount("close")).toBe(0);
  expect(hanging.listenerCount("close")).toBe(0);
  expect(vi.getTimerCount()).toBe(0);
});
