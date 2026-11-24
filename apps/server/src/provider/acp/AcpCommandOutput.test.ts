import { EventId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import {
  ACP_OUTPUT_TRUNCATION_MARKER,
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
    ).toBe("a\nb");
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

describe("AcpCommandOutputTracker edge cases", () => {
  const content = (...texts: string[]) =>
    texts.map((text) => ({ type: "content", content: { type: "text", text } }));
  const truncated = (full: string) =>
    full.length <= 8_000 ? full : `${ACP_OUTPUT_TRUNCATION_MARKER}${full.slice(-8_000)}`;
  const line = (index: number) => `line ${index.toString().padStart(5, "0")}\n`;
  const lines = (count: number) =>
    Array.from({ length: count }, (_, index) => line(index)).join("");

  it("lets content text through when rawOutput.output is empty, and keeps blocks apart", () => {
    expect(acpCommandOutputText({ rawOutput: { output: "" }, content: content("a", "b") })).toBe(
      "a\nb",
    );
  });

  it("keeps streaming new output after the runtime starts truncating it", () => {
    const tracker = new AcpCommandOutputTracker();
    let emitted = "";
    // 11 characters a line: crosses the 8,000-character bound after ~730 lines.
    for (const count of [300, 700, 900, 1_200, 1_500]) {
      const delta = tracker.next(
        execute({ rawOutput: { output: truncated(lines(count)) } }, "inProgress"),
      );
      emitted += delta ?? "";
    }
    emitted += tracker.next(execute({ rawOutput: { output: truncated(lines(1_600)) } })) ?? "";
    expect(emitted).toBe(lines(1_600));
  });

  it("marks a gap when an update skips past everything already emitted", () => {
    const tracker = new AcpCommandOutputTracker();
    expect(tracker.next(execute({ rawOutput: { output: lines(100) } }, "inProgress"))).toBe(
      lines(100),
    );
    const full = lines(5_000);
    const delta = tracker.next(execute({ rawOutput: { output: truncated(full) } }));
    expect(delta).toBe(`\n${ACP_OUTPUT_TRUNCATION_MARKER}${full.slice(-8_000)}`);
  });

  it("never splits a registered credential across two chunks", () => {
    const credential = "abcdefgh12345678";
    const holdback = (text: string) => {
      for (let length = credential.length - 1; length > 0; length--)
        if (text.endsWith(credential.slice(0, length))) return length;
      return 0;
    };
    const tracker = new AcpCommandOutputTracker(holdback);
    const first = tracker.next(execute({ rawOutput: { output: "token=abcdefgh" } }, "inProgress"));
    expect(first).toBe("token=");
    const second = tracker.next(
      execute({ rawOutput: { output: "token=abcdefgh12345678 done" } }, "inProgress"),
    );
    // The whole credential is in one chunk, where publishing scrubs it.
    expect(second).toBe("abcdefgh12345678 done");
    // Held text is flushed when the command ends.
    const third = tracker.next(
      execute({ rawOutput: { output: "token=abcdefgh12345678 done abc" } }, "inProgress"),
    );
    expect(third).toBe(" ");
    expect(
      tracker.next(execute({ rawOutput: { output: "token=abcdefgh12345678 done abc" } })),
    ).toBe("abc");
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
