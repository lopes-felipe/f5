import { expect, it } from "vitest";
import { PiNativeWake, PI_NATIVE_WAKE_ADMISSION_MS } from "./PiNativeWake.ts";
import { PiUiRequests } from "./PiUiRequests.ts";
it("releases buffered native output only once to its exact request and session generation", () => {
  const wake = new PiNativeWake("request", "generation", 100);
  const events = [
    { type: "agent_start" },
    { type: "message_start", message: { role: "assistant" } },
    { type: "agent_settled" },
  ];
  for (const event of events) expect(wake.push(event, 101)).toBe(true);
  expect(wake.take("other", "generation", 102)).toBeNull();
  expect(wake.take("request", "replacement", 102)).toBeNull();
  expect(wake.size).toBe(3);
  expect(wake.take("request", "generation", 102)).toEqual(events);
  expect(wake.size).toBe(0);
  expect(wake.take("request", "generation", 103)).toBeNull();
  expect(wake.push({ type: "agent_start" }, 103)).toBe(false);
});
it.each([160, 170])(
  "preserves native dialog deadlines while F5 admission is pending: %s",
  (now) => {
    const wake = new PiNativeWake("request", "generation", 100);
    const event = {
      type: "extension_ui_request",
      id: "native",
      method: "confirm",
      title: "Allow?",
      timeout: 50,
    };
    wake.push(event, 110);
    const buffered = wake.take("request", "generation", now)!;
    expect(buffered[0]?.timeout).toBe(-1);
    expect(event.timeout).toBe(50);
    expect(new PiUiRequests("generation").open(buffered[0]!, "host", 170)).toMatchObject({
      type: "cancelled",
      record: { id: "native", cancelled: true },
    });
  },
);
it("does not convert Pi's zero/infinite dialog timeout into immediate cancellation", () => {
  const wake = new PiNativeWake("request", "generation", 100);
  wake.push({ type: "extension_ui_request", id: "native", method: "confirm", timeout: 0 }, 101);
  expect(wake.take("request", "generation", 1000)?.[0]?.timeout).toBe(0);
});
it("bounds admission time, event count and UTF-8 bytes without dropping an earlier event silently", () => {
  const expired = new PiNativeWake("request", "generation", 100);
  expect(expired.push({ type: "agent_start" }, 100 + PI_NATIVE_WAKE_ADMISSION_MS)).toBe(false);
  expect(expired.take("request", "generation", Infinity)).toBeNull();
  const wake = new PiNativeWake("request", "generation", 100);
  for (let i = 0; i < 256; i++) expect(wake.push({ type: "event" }, 101)).toBe(true);
  expect(wake.push({ type: "extra" }, 102)).toBe(false);
  expect(wake.take("request", "generation", 103)).toHaveLength(256);
  const huge = new PiNativeWake("request", "generation", 100);
  expect(huge.push({ type: "event", text: "界".repeat(800_000) }, 101)).toBe(false);
  expect(huge.size).toBe(0);
  huge.cancel();
  expect(huge.take("request", "generation", 102)).toBeNull();
});
