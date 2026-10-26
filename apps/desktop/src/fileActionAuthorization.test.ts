import { expect, it, vi, afterEach } from "vitest";
import { FileActionAuthorizations } from "./fileActionAuthorization";
afterEach(() => vi.useRealTimers());

it("retains one authorization across slow async work and rejects reuse", () => {
  vi.useFakeTimers();
  const auth = new FileActionAuthorizations();
  const token = auth.prepare(1, "/tmp/report.json", true);
  vi.advanceTimersByTime(1500);
  expect(() => auth.consume(1, "/tmp/report.json", false, token)).not.toThrow();
  expect(() => auth.consume(1, "/tmp/report.json", false, token)).toThrow("authorization");
});
it("accepts a native menu selection without a DOM event, scoped to its owner and target", () => {
  const auth = new FileActionAuthorizations();
  auth.nativeMenuSelected(1, "/tmp/report.json");
  expect(() => auth.prepare(2, "/tmp/report.json", false)).toThrow();
  expect(() => auth.prepare(1, "/tmp/other.json", false)).toThrow();
  const token = auth.prepare(1, "/tmp/report.json", false);
  expect(() => auth.consume(2, "/tmp/report.json", false, token)).toThrow();
  expect(() => auth.consume(1, "/tmp/other.json", false, token)).toThrow();
  expect(() => auth.consume(1, "/tmp/report.json", false, token)).not.toThrow();
});
it("requires authorization even when the target is not known until configuration loads", () => {
  const auth = new FileActionAuthorizations();
  expect(() => auth.prepare(1, undefined, false)).toThrow();
  const token = auth.prepare(1, undefined, true);
  expect(() => auth.consume(1, "/tmp/keybindings.json", false, token)).not.toThrow();
});
it("expires pending handoffs", () => {
  vi.useFakeTimers();
  const auth = new FileActionAuthorizations();
  const token = auth.prepare(1, "/tmp/report.json", true);
  vi.advanceTimersByTime(5 * 60_000);
  expect(() => auth.consume(1, "/tmp/report.json", false, token)).toThrow();
});

it("releases unused handoffs without exhausting capacity and preserves owner isolation", () => {
  const auth = new FileActionAuthorizations();
  for (let i = 0; i < 256; i++) {
    const token = auth.prepare(1, "/tmp/report.json", true);
    auth.release(1, token);
  }
  const token = auth.prepare(1, "/tmp/report.json", true);
  auth.release(2, token);
  expect(() => auth.consume(1, "/tmp/report.json", false, token)).not.toThrow();
  auth.release(1, token);
  expect(() => auth.consume(1, "/tmp/report.json", false, token)).toThrow();
  const released = auth.prepare(1, "/tmp/report.json", true);
  auth.release(1, released);
  expect(() => auth.consume(1, "/tmp/report.json", false, released)).toThrow();
});
