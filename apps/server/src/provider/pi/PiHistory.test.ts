import { ThreadId } from "@t3tools/contracts";
import { Effect } from "effect";
import { expect, it } from "vitest";
import { readPiHistory, type PiHistoryRequest, type PiResumeCursor } from "./PiHistory.ts";

const entry = (id: string, parentId: string | null, role = "user") => ({
  id,
  parentId,
  type: "message",
  message: { role, content: id },
});
const tree = {
  leafId: "a2",
  entries: [
    entry("abandoned", "u1"),
    entry("a2", "u2", "assistant"),
    entry("u1", null),
    entry("u2", "a1"),
    entry("a1", "u1", "assistant"),
  ],
};
const messages = [
  entry("u1", null).message,
  entry("a1", "u1", "assistant").message,
  entry("u2", "a1").message,
  entry("a2", "u2", "assistant").message,
];
const cursor: PiResumeCursor = {
  schemaVersion: 1,
  sessionFile: "/native/session.jsonl",
  leafId: "a2",
  boundaries: [
    { turnId: "host-1", entryId: "u1" },
    { turnId: "host-2", entryId: "u2" },
  ],
};
const threadId = ThreadId.makeUnsafe("pi-history");
const request = (overrides?: {
  entriesAfter?: unknown;
  initialEntries?: unknown;
  finalState?: unknown;
  messages?: unknown;
}): PiHistoryRequest => {
  let states = 0,
    entries = 0;
  return (record) =>
    Effect.sync(() => {
      if (record.type === "get_state")
        return ++states > 1 && overrides?.finalState
          ? overrides.finalState
          : { sessionFile: cursor.sessionFile, isStreaming: false };
      if (record.type === "get_entries")
        return ++entries > 1 && overrides?.entriesAfter
          ? overrides.entriesAfter
          : (overrides?.initialEntries ?? tree);
      if (record.type === "get_messages") return { messages: overrides?.messages ?? messages };
      throw new Error("Unexpected Pi history request.");
    });
};
it("reads only native active messages while retaining host turn identities across abandoned branches", async () => {
  const result = await Effect.runPromise(readPiHistory({ threadId, cursor, request: request() }));
  expect(result.snapshot.turns.map((turn) => turn.id)).toEqual(["host-1", "host-2"]);
  expect(JSON.stringify(result.snapshot)).not.toContain("abandoned");
  expect(result.snapshot.history).toMatchObject({
    provenance: "provider-persisted",
    coverage: "complete",
    identity: cursor.sessionFile,
    boundary: "a2",
  });
});
it("retains older native rewind boundaries when compaction removes their messages from active model context", async () => {
  const result = await Effect.runPromise(
    readPiHistory({ threadId, cursor, request: request({ messages: messages.slice(2) }) }),
  );
  expect(result.snapshot.turns.map((turn) => [turn.id, turn.items.length])).toEqual([
    ["host-1", 0],
    ["host-2", 2],
  ]);
});
it.each([
  { entriesAfter: { ...tree, leafId: "a1" } },
  { finalState: { sessionFile: "/native/replacement.jsonl", isStreaming: false } },
  { finalState: { sessionFile: cursor.sessionFile, isStreaming: true } },
  { messages: [...messages, { role: "user", content: "uncorrelated" }] },
])(
  "fails a changed or uncorrelated snapshot instead of returning partial history: %j",
  async (overrides) => {
    const result = await Effect.runPromise(
      readPiHistory({ threadId, cursor, request: request(overrides) }).pipe(Effect.result),
    );
    expect(result._tag).toBe("Failure");
  },
);

it("preserves assistant-only F5 continuation turns and later user-turn boundaries", async () => {
  const wake = entry("wake", "a1", "assistant");
  const withWake = {
    ...tree,
    entries: tree.entries
      .map((node) => (node.id === "u2" ? { ...node, parentId: "wake" } : node))
      .concat(wake),
  };
  const withCursor: PiResumeCursor = {
    ...cursor,
    boundaries: [
      cursor.boundaries[0]!,
      { turnId: "host-wake", entryId: "wake", kind: "continuation" },
      cursor.boundaries[1]!,
    ],
  };
  const active = [
    ...messages.slice(0, 2),
    { content: wake.message.content, role: wake.message.role },
    ...messages.slice(2),
  ];
  const result = await Effect.runPromise(
    readPiHistory({
      threadId,
      cursor: withCursor,
      request: request({ initialEntries: withWake, messages: active }),
    }),
  );
  expect(result.snapshot.turns.map((turn) => [turn.id, turn.items.length])).toEqual([
    ["host-1", 2],
    ["host-wake", 1],
    ["host-2", 2],
  ]);
  expect(result.turnEntryIds).toEqual(["u1", "wake", "u2"]);
  expect(result.userEntryIds).toEqual(["u1", "u2"]);
  const compacted = await Effect.runPromise(
    readPiHistory({
      threadId,
      cursor: withCursor,
      request: request({ initialEntries: withWake, messages: messages.slice(2) }),
    }),
  );
  expect(compacted.snapshot.turns.map((turn) => [turn.id, turn.items.length])).toEqual([
    ["host-1", 0],
    ["host-wake", 0],
    ["host-2", 2],
  ]);
});
it("refuses assistant-only continuation correlation when native messages have duplicate identities", async () => {
  const wake = {
    ...entry("wake", "a1", "assistant"),
    message: entry("a1", "u1", "assistant").message,
  };
  const withWake = {
    ...tree,
    entries: tree.entries
      .map((node) => (node.id === "u2" ? { ...node, parentId: "wake" } : node))
      .concat(wake),
  };
  const withCursor: PiResumeCursor = {
    ...cursor,
    boundaries: [
      ...cursor.boundaries,
      { turnId: "host-wake", entryId: "wake", kind: "continuation" },
    ],
  };
  const result = await Effect.runPromise(
    readPiHistory({
      threadId,
      cursor: withCursor,
      request: request({ initialEntries: withWake }),
    }).pipe(Effect.result),
  );
  expect(result._tag).toBe("Failure");
});
