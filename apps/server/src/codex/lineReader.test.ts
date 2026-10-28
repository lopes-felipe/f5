import { PassThrough } from "node:stream";
import { expect, it } from "vitest";
import { ProviderLineReader } from "./lineReader.ts";

it("finishes received UTF-8 fragments once and detaches a source that never reaches EOF", () => {
  const source = new PassThrough();
  const reader = new ProviderLineReader(source);
  const events: string[] = [];
  reader.on("line", (line) => events.push(line));
  reader.on("close", () => events.push("closed"));
  const bytes = Buffer.from('first\r\n{"text":"😀"}');
  source.write(bytes.subarray(0, bytes.length - 3));
  source.write(bytes.subarray(bytes.length - 3));
  expect(events).toEqual(["first"]);
  reader.finish();
  reader.finish();
  reader.close();
  source.write("late\n");
  expect(events).toEqual(["first", '{"text":"😀"}', "closed"]);
  expect(
    source.listenerCount("data") + source.listenerCount("end") + source.listenerCount("close"),
  ).toBe(0);
  source.destroy();
});
it("explicit cancellation discards an unfinished frame without publishing it", () => {
  const source = new PassThrough();
  const reader = new ProviderLineReader(source);
  const lines: string[] = [];
  reader.on("line", (line) => lines.push(line));
  source.write("unfinished");
  reader.close();
  reader.finish();
  expect(lines).toEqual([]);
  source.destroy();
});
it("reports a line over the byte cap once and stops reading instead of buffering it", () => {
  const source = new PassThrough();
  const reader = new ProviderLineReader(source, 8);
  const events: string[] = [];
  reader.on("line", (line) => events.push(line));
  reader.on("overflow", (error) => events.push(`overflow: ${error.message}`));
  reader.on("close", () => events.push("closed"));
  // "é" is two UTF-8 bytes, so eight characters split across chunks exceed eight bytes.
  source.write("ok\nééé");
  source.write("é");
  expect(events).toEqual(["ok"]);
  source.write("é\n");
  source.write("late\n");
  source.end();
  expect(events).toEqual([
    "ok",
    "overflow: Provider stdout line exceeds the 8 byte limit",
    "closed",
  ]);
  expect(source.listenerCount("data")).toBe(0);
  source.destroy();
});
