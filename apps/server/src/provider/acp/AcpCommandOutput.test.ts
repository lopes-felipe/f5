import { EventId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import {
  AcpCommandOutputTracker,
  acpCommandOutputText,
  makeAcpCommandOutputEvent,
} from "./AcpCommandOutput.ts";
import type { AcpToolCallState } from "./AcpRuntimeModel.ts";

const execute = (
  data: Record<string, unknown>,
  status: AcpToolCallState["status"] = "completed",
  toolCallId = "call-1",
): AcpToolCallState => ({ toolCallId, kind: "execute", status, data });

describe("acpCommandOutputText", () => {
  it("reads every output shape ACP agents send", () => {
    expect(acpCommandOutputText({ rawOutput: { output: "ls\r\n", exit_code: 0 } })).toBe("ls\r\n");
    expect(acpCommandOutputText({ rawOutput: { output: "grok", exitCode: 0 } })).toBe("grok");
    expect(acpCommandOutputText({ rawOutput: { stdout: "out" } })).toBe("out");
    expect(acpCommandOutputText({ rawOutput: "user denied permission to run command" })).toBe(
      "user denied permission to run command",
    );
    expect(
      acpCommandOutputText({
        content: [
          { type: "content", content: { type: "text", text: "a" } },
          { type: "diff", path: "/x", newText: "ignored" },
          { type: "content", content: { type: "text", text: "b" } },
        ],
      }),
    ).toBe("ab");
    expect(acpCommandOutputText({ rawOutput: { exitCode: 0 } })).toBe("");
  });

  it("prefers rawOutput over the content mirror", () => {
    expect(
      acpCommandOutputText({
        rawOutput: { output: "raw" },
        content: [{ type: "content", content: { type: "text", text: "mirror" } }],
      }),
    ).toBe("raw");
  });
});

describe("AcpCommandOutputTracker", () => {
  it("emits output once, even when an update repeats it", () => {
    const tracker = new AcpCommandOutputTracker();
    expect(tracker.next(execute({ rawOutput: { output: "done" } }))).toBe("done");
    expect(tracker.next(execute({ rawOutput: { output: "x" } }, "inProgress", "c2"))).toBe("x");
    expect(tracker.next(execute({ rawOutput: { output: "x" } }, "inProgress", "c2"))).toBe(
      undefined,
    );
  });

  it("emits only the new suffix while output grows", () => {
    const tracker = new AcpCommandOutputTracker();
    expect(tracker.next(execute({ rawOutput: { output: "a" } }, "inProgress"))).toBe("a");
    expect(tracker.next(execute({ rawOutput: { output: "ab" } }, "inProgress"))).toBe("b");
    expect(tracker.next(execute({ rawOutput: { output: "abc" } }, "completed"))).toBe("c");
  });

  it("does not append rewritten output", () => {
    const tracker = new AcpCommandOutputTracker();
    expect(tracker.next(execute({ rawOutput: { output: "first" } }, "inProgress"))).toBe("first");
    expect(tracker.next(execute({ rawOutput: { output: "other" } }, "completed"))).toBe(undefined);
  });

  it("ignores empty output and tools that are not commands", () => {
    const tracker = new AcpCommandOutputTracker();
    expect(tracker.next(execute({ rawOutput: { output: "" } }))).toBe(undefined);
    expect(
      tracker.next({
        toolCallId: "read",
        kind: "read",
        status: "completed",
        data: { rawOutput: { output: "file text" } },
      }),
    ).toBe(undefined);
  });
});

describe("makeAcpCommandOutputEvent", () => {
  it("builds a command_output delta for the tool's item", () => {
    const event = makeAcpCommandOutputEvent({
      stamp: { eventId: EventId.make("event-1"), createdAt: "2026-11-24T00:00:00.000Z" },
      provider: "antigravity",
      threadId: ThreadId.make("thread-1"),
      turnId: undefined,
      toolCallId: "call-1",
      text: "hello",
      rawPayload: {},
    });
    expect(event).toMatchObject({
      type: "content.delta",
      itemId: "call-1",
      payload: { streamKind: "command_output", delta: "hello" },
    });
  });
});
