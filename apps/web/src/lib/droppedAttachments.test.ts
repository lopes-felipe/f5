import { expect, it } from "vitest";

import { partitionDroppedAttachments } from "./droppedAttachments";

const item = (file: File, isDirectory: boolean) => ({
  kind: "file" as const,
  getAsFile: () => file,
  webkitGetAsEntry: () => ({ isDirectory }),
});

it("classifies each dropped file by its own entry, even when names collide", () => {
  const folder = new File([], "notes");
  const sameNamedFile = new File(["text"], "notes");
  const archive = new File(["zip"], "bundle.zip");
  const result = partitionDroppedAttachments({
    items: [item(folder, true), item(sameNamedFile, false), item(archive, false)],
    files: [] as unknown as FileList,
  });
  expect(result.folders).toEqual([folder]);
  expect(result.files).toEqual([sameNamedFile, archive]);
});

it("ignores string items and falls back to files when no file items are exposed", () => {
  const file = new File(["x"], "a.txt");
  const withText = partitionDroppedAttachments({
    items: [{ kind: "string" as const, getAsFile: () => null }, item(file, false)],
    files: [] as unknown as FileList,
  });
  expect(withText).toEqual({ files: [file], folders: [] });
  expect(partitionDroppedAttachments({ items: [], files: [file] as unknown as FileList })).toEqual({
    files: [file],
    folders: [],
  });
});
