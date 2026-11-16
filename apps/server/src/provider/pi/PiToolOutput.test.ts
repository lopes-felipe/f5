import { expect, it } from "vitest";
import { piToolPayload } from "./PiToolOutput.ts";
const base = { callId: "call", name: "bash", args: { command: "exit 2" }, completed: true };
it("preserves shell exit codes and distinguishes semantic failure from transport errors", () => {
  const payload = piToolPayload({ ...base, result: { structuredContent: { exit_code: 2 } } });
  expect(payload).toMatchObject({
    itemType: "command_execution",
    status: "failed",
    data: { exitCode: 2 },
    completion: { nativeCallId: "call", transportError: false, semanticSuccess: false },
  });
  expect(
    piToolPayload({ ...base, result: { details: { exitCode: 0 } } }).completion?.semanticSuccess,
  ).toBe(true);
});
it("preserves structured MCP results and native error flags", () => {
  const result = {
    content: [{ type: "text", text: "Details" }],
    structuredContent: { success: false, value: 2 },
  };
  const payload = piToolPayload({ ...base, name: "mcp__f5__tool", result });
  expect(payload).toMatchObject({
    itemType: "mcp_tool_call",
    completion: { structuredOutput: result, semanticSuccess: false, transportError: false },
  });
  expect(
    piToolPayload({ ...base, name: "read", result, isError: true }).completion?.transportError,
  ).toBe(true);
});
it("caps retained arguments and output without allocating a large serialized copy", () => {
  const payload = piToolPayload({
    ...base,
    args: { command: "x".repeat(100_000) },
    result: { text: "界".repeat(100_000) },
  });
  expect(payload.completion).toMatchObject({
    inputOmission: { reason: "too-large" },
    outputOmission: { reason: "too-large" },
  });
  expect(Buffer.byteLength(JSON.stringify(payload))).toBeLessThan(8192);
});
it("only attaches completion envelopes to finished native calls", () => {
  expect(piToolPayload({ ...base, completed: false }).completion).toBeUndefined();
  expect(
    piToolPayload({ ...base, name: "write", args: { path: "a.txt", content: "New" } }),
  ).toMatchObject({ itemType: "file_change", data: { path: "a.txt" } });
});
