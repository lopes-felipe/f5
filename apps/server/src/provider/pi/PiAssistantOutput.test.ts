import { expect, it } from "vitest";
import { PiAssistantOutput } from "./PiAssistantOutput.ts";
const start = { type: "message_start", message: { role: "assistant" } };
const delta = (text: string, index = 0) => ({
  type: "message_update",
  assistantMessageEvent: { type: "text_delta", contentIndex: index, delta: text },
});
const end = (text: string) => ({
  type: "message_end",
  message: { role: "assistant", content: [{ type: "text", text }] },
});
it("projects one start and completion, fills missing deltas and suppresses duplicate completion", () => {
  const output = new PiAssistantOutput();
  expect(output.observe(start)).toEqual([]);
  expect(output.observe(delta("Hel"))?.map((action) => action.type)).toEqual(["start", "delta"]);
  expect(output.observe(end("Hello"))).toMatchObject([
    { type: "delta", text: "lo" },
    { type: "complete", text: "Hello" },
  ]);
  expect(output.observe(end("Hello"))).toEqual([]);
  expect(output.observe(delta("Late"))).toBeNull();
});
it("projects complete-only messages and separates reasoning from visible text", () => {
  const output = new PiAssistantOutput();
  output.observe(start);
  const result = output.observe({
    type: "message_end",
    message: {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "Think" },
        { type: "text", text: "Answer" },
      ],
    },
  });
  expect(result?.filter((action) => action.type === "complete")).toMatchObject([
    { reasoning: true, text: "Think" },
    { reasoning: false, text: "Answer" },
  ]);
});
it("releases completed message buffers and gives later messages distinct identities", () => {
  const output = new PiAssistantOutput();
  output.observe(start);
  const first = output.observe(end("x".repeat(1024 * 1024)))![0]!.itemId;
  output.observe(start);
  const second = output.observe(end("y".repeat(1024 * 1024)))![0]!.itemId;
  expect(first).not.toBe(second);
  output.clear();
  expect(output.observe(start)).toEqual([]);
  expect(output.observe(end("Fresh"))).not.toBeNull();
});
it("rejects inconsistent final content, missing blocks, malformed indexes and oversized UTF-8 output", () => {
  for (const invalid of [
    end("Other"),
    { type: "message_end", message: { role: "assistant", content: [] } },
    delta("x", -1),
    delta("x", 256),
    delta("x", 0.5),
    delta("界".repeat(800_000)),
  ]) {
    const output = new PiAssistantOutput();
    output.observe(start);
    output.observe(delta("First"));
    expect(output.observe(invalid)).toBeNull();
  }
});

it("completes an interrupted message once without inventing a final delta", () => {
  const output = new PiAssistantOutput();
  output.observe(start);
  output.observe(delta("Partial"));
  expect(output.completeOpen()).toMatchObject([{ type: "complete", text: "Partial" }]);
  expect(output.completeOpen()).toEqual([]);
});
