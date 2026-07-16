import { ThreadId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vitest";

import {
  clearPreviewProjection,
  MAX_PERSISTENT_PREVIEW_INSTANCES,
  projectPreviewEntry,
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
});
