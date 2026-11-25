import { expect, it } from "vitest";
import { attachmentSources } from "./attachmentUploadQueue";
import {
  findSnapshotContext,
  restoreClipboardSnapshot,
  snapshotClipboardHtml,
} from "./snapshotClipboard";

it.each(["png", "webp"])(
  "restores a Snap Shot %s and its accessibility context as PNG",
  async (extension) => {
    const image = { id: "image", name: "window-abcd." + extension, source: "snapshot" } as const;
    const context = {
      id: "context",
      name: "window-abcd-context.txt",
      source: "snapshot",
      file: new File(["App — Window\n<details> Héllo"], "context", { type: "text/plain" }),
    } as const;
    const html = await snapshotClipboardHtml(
      image.name,
      findSnapshotContext(image, [image, context]),
    );
    const files = restoreClipboardSnapshot(
      [new File([new Uint8Array([1, 2, 3])], "clipboard.png", { type: "image/png" })],
      { getData: () => html } as unknown as DataTransfer,
    );
    expect(files.map(({ name }) => name)).toEqual(["window-abcd.png", context.name]);
    expect(files.map((file) => attachmentSources.get(file))).toEqual(["snapshot", "snapshot"]);
    expect(await files[1]?.text()).toBe("App — Window\n<details> Héllo");
  },
);

it("keeps an ordinary clipboard image unchanged when its metadata cannot be read", () => {
  const files = [new File([], "clipboard.png", { type: "image/png" })];
  expect(
    restoreClipboardSnapshot(files, {
      getData: () => '<span data-f5-snapshot="%not-json">broken</span>',
    } as unknown as DataTransfer),
  ).toBe(files);
});
