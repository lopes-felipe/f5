import { expect, it } from "vitest";
import { editorDrafts, editorFileKey, type EditorDraft } from "./editorDrafts";
function draft(branch: string, revision: number, text: string): EditorDraft {
  const fileKey = editorFileKey("profile", "/canonical/workspace", crypto.randomUUID());
  return {
    fileKey,
    key: JSON.stringify([fileKey, branch]),
    branchId: branch,
    revision,
    text,
    baseHash: "base",
    baseContents: "base",
    saveStatus: "dirty",
    updatedAt: Date.now(),
  };
}
it("keeps independent window branches and rejects out-of-order writes", async () => {
  const first = draft("window-a", 2, "newer");
  const second = { ...first, branchId: "window-b", key: `${first.key}-b`, text: "other window" };
  await Promise.all([
    editorDrafts.put(first),
    editorDrafts.put({ ...first, revision: 1, text: "older" }),
    editorDrafts.put(second),
  ]);
  const records = await editorDrafts.list(first.fileKey);
  expect(records.map((record) => record.text).sort()).toEqual(["newer", "other window"]);
});
it("an old save advances the base without clearing newer text; a late old write cannot resurrect an acknowledged draft", async () => {
  const saved = draft("branch", 1, "saved text");
  await editorDrafts.put(saved);
  await editorDrafts.put({ ...saved, revision: 2, text: "newer edit" });
  await editorDrafts.acknowledge(saved, "new-base");
  expect(await editorDrafts.list(saved.fileKey)).toEqual([
    expect.objectContaining({
      revision: 2,
      text: "newer edit",
      baseHash: "new-base",
      baseContents: "saved text",
    }),
  ]);
  await editorDrafts.acknowledge({ ...saved, revision: 2 }, "final");
  await editorDrafts.put(saved);
  expect(await editorDrafts.list(saved.fileKey)).toEqual([]);
  await editorDrafts.put({ ...saved, revision: 3, text: "next edit" });
  expect(await editorDrafts.list(saved.fileKey)).toHaveLength(1);
});

it("reopens storage after the browser closes the database connection", async () => {
  const record = draft("closed-connection", 1, "saved after reopen");
  await editorDrafts.list(record.fileKey);
  const original = IDBDatabase.prototype.transaction;
  // Chromium keeps throwing on a connection it closed, e.g. after evicting site storage.
  let closed: IDBDatabase | undefined;
  IDBDatabase.prototype.transaction = function (this: IDBDatabase, ...args) {
    closed ??= this;
    if (this === closed)
      throw new DOMException("The database connection is closing.", "InvalidStateError");
    return original.apply(this, args);
  } as IDBDatabase["transaction"];
  try {
    await editorDrafts.put(record);
    expect(await editorDrafts.list(record.fileKey, true)).toEqual([record]);
  } finally {
    IDBDatabase.prototype.transaction = original;
  }
});
it("retains a memory recovery branch when IndexedDB transactions fail", async () => {
  const record = draft("storage-failure", 1, "keep this text");
  // Ensure the database has opened before making its transaction layer fail.
  await editorDrafts.list(record.fileKey);
  const original = IDBDatabase.prototype.transaction;
  IDBDatabase.prototype.transaction = () => {
    throw new DOMException("quota", "QuotaExceededError");
  };
  try {
    await expect(editorDrafts.put(record)).rejects.toThrow("quota");
    expect(await editorDrafts.list(record.fileKey)).toEqual([record]);
  } finally {
    IDBDatabase.prototype.transaction = original;
  }
});
