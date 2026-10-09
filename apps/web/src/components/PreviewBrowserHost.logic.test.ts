import { ThreadId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vitest";

import {
  clearPreviewProjection,
  ensureHeadlessPreviewEntry,
  MAX_PERSISTENT_PREVIEW_INSTANCES,
  MAX_PINNED_PREVIEW_INSTANCES,
  projectPreviewEntry,
  unpinPreviewEntry,
  type PreviewProjectionEntry,
} from "./PreviewBrowserHost.logic";

describe("persistent preview projection state", () => {
  it("retains a hidden runtime across target unmount and ignores stale cleanup", () => {
    const threadId = ThreadId.makeUnsafe("thread-preview");
    const firstTarget = { id: "first" };
    const secondTarget = { id: "second" };
    const onClose = vi.fn();
    let entries: ReadonlyMap<ThreadId, PreviewProjectionEntry<typeof firstTarget>> = new Map();

    entries = projectPreviewEntry(entries, {
      threadId,
      target: firstTarget,
      visible: true,
      onClose,
    });
    entries = clearPreviewProjection(entries, threadId, firstTarget);

    expect(entries.get(threadId)).toMatchObject({ target: null, visible: false });

    entries = projectPreviewEntry(entries, {
      threadId,
      target: secondTarget,
      visible: true,
      onClose,
    });
    const beforeStaleCleanup = entries;
    entries = clearPreviewProjection(entries, threadId, firstTarget);

    expect(entries).toBe(beforeStaleCleanup);
    expect(entries.get(threadId)).toMatchObject({ target: secondTarget, visible: true });
  });

  it("bounds hidden preview runtimes and evicts the least recently projected thread", () => {
    let entries: ReadonlyMap<ThreadId, PreviewProjectionEntry<{ id: number }>> = new Map();
    const threadIds = Array.from({ length: MAX_PERSISTENT_PREVIEW_INSTANCES + 1 }, (_, index) =>
      ThreadId.makeUnsafe(`thread-${index}`),
    );

    for (const [index, threadId] of threadIds.entries()) {
      entries = projectPreviewEntry(entries, {
        threadId,
        target: { id: index },
        visible: false,
        onClose: vi.fn(),
      });
    }

    expect(entries.size).toBe(MAX_PERSISTENT_PREVIEW_INSTANCES);
    expect(entries.has(threadIds[0]!)).toBe(false);
    expect(entries.has(threadIds.at(-1)!)).toBe(true);
  });

  it("pins agent previews against eviction and refuses past the pinned limit", () => {
    let entries: ReadonlyMap<ThreadId, PreviewProjectionEntry<{ id: number }>> = new Map();
    const agentA = ThreadId.makeUnsafe("agent-a");
    const agentB = ThreadId.makeUnsafe("agent-b");
    const agentC = ThreadId.makeUnsafe("agent-c");
    for (const threadId of [agentA, agentB]) {
      const result = ensureHeadlessPreviewEntry(entries, threadId, vi.fn());
      if (!result.ok) throw new Error("expected a slot");
      entries = result.entries;
    }
    expect(ensureHeadlessPreviewEntry(entries, agentC, vi.fn())).toEqual({
      ok: false,
      reason: "capacity-exceeded",
    });
    expect(MAX_PINNED_PREVIEW_INSTANCES).toBe(2);
    for (let index = 0; index < MAX_PERSISTENT_PREVIEW_INSTANCES + 2; index += 1) {
      entries = projectPreviewEntry(entries, {
        threadId: ThreadId.makeUnsafe(`user-${index}`),
        target: { id: index },
        visible: false,
        onClose: vi.fn(),
      });
    }
    expect(entries.get(agentA)?.pinned).toBe(true);
    expect(entries.get(agentB)?.pinned).toBe(true);
    expect(entries.size).toBe(MAX_PERSISTENT_PREVIEW_INSTANCES);
  });

  it("keeps the pin when the user opens an agent preview and drops unseen ones on release", () => {
    const shown = ThreadId.makeUnsafe("shown");
    const unseen = ThreadId.makeUnsafe("unseen");
    let entries: ReadonlyMap<ThreadId, PreviewProjectionEntry<{ id: number }>> = new Map();
    for (const threadId of [shown, unseen]) {
      const result = ensureHeadlessPreviewEntry(entries, threadId, vi.fn());
      if (!result.ok) throw new Error("expected a slot");
      entries = result.entries;
    }
    entries = projectPreviewEntry(entries, {
      threadId: shown,
      target: { id: 1 },
      visible: true,
      onClose: vi.fn(),
    });
    expect(entries.get(shown)).toMatchObject({ pinned: true, visible: true });
    entries = unpinPreviewEntry(entries, shown);
    entries = unpinPreviewEntry(entries, unseen);
    expect(entries.get(shown)?.pinned).toBe(false);
    expect(entries.has(unseen)).toBe(false);
  });
});
