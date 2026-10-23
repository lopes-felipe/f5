import { expect, it } from "vitest";
import { PiLineFramer } from "./PiLineFramer.ts";

it("splits on LF only and preserves Unicode separators across every byte boundary", () => {
  const framer = new PiLineFramer(4096);
  const first = JSON.stringify({ type: "notice", text: "a\u2028b\u2029c🐈" });
  const bytes = new TextEncoder().encode(first + '\r\n\n{"type":"done"}\n');
  const lines: string[] = [];
  for (const byte of bytes) lines.push(...framer.push(Uint8Array.of(byte)));
  expect(lines).toEqual([first, '{"type":"done"}']);
  expect(framer.finish()).toBeUndefined();
});
it("bounds bytes even without LF and resets the frame after each newline", () => {
  const framer = new PiLineFramer(5);
  expect([...framer.push(new TextEncoder().encode("abcd\nefg\n"))]).toEqual(["abcd", "efg"]);
  expect(() => [...framer.push(new TextEncoder().encode("🐈🐈"))]).toThrow(/byte limit/);
});
it("reads a final unterminated frame and rejects invalid UTF-8", () => {
  const framer = new PiLineFramer(100);
  expect([...framer.push(new TextEncoder().encode("abc\r"))]).toEqual([]);
  expect(framer.finish()).toBe("abc");
  expect(() => [...framer.push(Uint8Array.of(0xff, 10))]).toThrow();
});
