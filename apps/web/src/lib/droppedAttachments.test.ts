import { expect, it } from "vitest";

import { partitionDroppedAttachments } from "./droppedAttachments";
import { resolveAttachedFileReferencePaths } from "../components/ChatView.logic";
import { appendPendingUserInputFileReferences } from "../pendingUserInput";

const item = (file: File, isDirectory: boolean) => ({
  kind: "file" as const,
  getAsFile: () => file,
  webkitGetAsEntry: () => ({ isDirectory }),
});

it("routes a copied folder to desktop file references and question-answer text", () => {
  const folder = new File([], "notes");
  const clipboard = { items: [item(folder, true)], files: [folder] as unknown as FileList };
  const split = partitionDroppedAttachments(clipboard);
  expect(split.files).toEqual([]);
  const references = resolveAttachedFileReferencePaths({
    files: split.folders,
    isElectron: true,
    desktopBridge: { getPathForFile: () => "/repo/notes" },
    workspaceRoots: ["/repo"],
  });
  expect(references).toEqual({ filePaths: ["notes"], invalidPathCount: 0, missingPathCount: 0 });
  expect(
    appendPendingUserInputFileReferences({ customAnswer: "Inspect" }, references.filePaths)
      .customAnswer,
  ).toBe("Inspect\nnotes");
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
