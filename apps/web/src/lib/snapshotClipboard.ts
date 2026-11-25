import { setAttachmentSource } from "./attachmentUploadQueue";

const marker = "data-f5-snapshot";
export const SNAPSHOT_CONTEXT_MAX_CHARS = 20_000;

interface SnapshotAttachment {
  id: string;
  name: string;
  source?: "snapshot" | "pasted-text" | undefined;
  sourceUrl?: string | undefined;
  previewUrl?: string | undefined;
  file?: Blob | undefined;
}

export function findSnapshotContext<T extends SnapshotAttachment>(
  image: Pick<SnapshotAttachment, "name" | "source">,
  attachments: readonly T[],
): T | undefined {
  if (image.source !== "snapshot" || !/^window(?:-[a-f0-9-]+)?\.png$/.test(image.name)) return;
  if (attachments.filter(({ name }) => name === image.name).length !== 1) return;
  const name = image.name.replace(/\.png$/, "-context.txt");
  const context = attachments.filter((item) => item.name === name && item.source === "snapshot");
  return context.length === 1 ? context[0] : undefined;
}

export async function snapshotClipboardHtml(
  name: string,
  attachment?: SnapshotAttachment,
): Promise<string> {
  let context: string | undefined;
  if (attachment?.file && attachment.file.size > 0) {
    context = await attachment.file.slice(0, SNAPSHOT_CONTEXT_MAX_CHARS * 4).text();
  } else if (attachment?.sourceUrl || attachment?.previewUrl) {
    const response = await fetch(attachment.sourceUrl ?? attachment.previewUrl!, {
      credentials: "include",
      cache: "no-store",
    });
    if (!response.ok) throw new Error("The Snap Shot context could not be read.");
    context = (await response.text()).slice(0, SNAPSHOT_CONTEXT_MAX_CHARS);
  }
  const fragment = encodeURIComponent(
    JSON.stringify({ version: 1, name, context: context?.slice(0, SNAPSHOT_CONTEXT_MAX_CHARS) }),
  ).replaceAll("'", "%27");
  return `<span ${marker}='${fragment}'>F5 Snap Shot</span>`;
}

export function restoreClipboardSnapshot(files: File[], clipboard: DataTransfer): File[] {
  if (files.length !== 1 || files[0]?.type !== "image/png") return files;
  const html = clipboard.getData("text/html").slice(0, 256_000);
  const encoded = /<span\b[^>]*\bdata-f5-snapshot=["']([^"']{1,250000})["']/i.exec(html)?.[1];
  if (!encoded) return files;
  try {
    const fragment = JSON.parse(decodeURIComponent(encoded)) as {
      version?: unknown;
      name?: unknown;
      context?: unknown;
    };
    if (
      fragment.version !== 1 ||
      typeof fragment.name !== "string" ||
      !fragment.name ||
      fragment.name.length > 255 ||
      /[/\\\x00-\x1f]/.test(fragment.name)
    )
      return files;
    const image = setAttachmentSource(
      new File(files, fragment.name, { type: "image/png" }),
      "snapshot",
    );
    return typeof fragment.context === "string" &&
      fragment.context.length <= SNAPSHOT_CONTEXT_MAX_CHARS
      ? [
          image,
          setAttachmentSource(
            new File([fragment.context], fragment.name.replace(/\.png$/i, "") + "-context.txt", {
              type: "text/plain",
            }),
            "snapshot",
          ),
        ]
      : [image];
  } catch {
    return files;
  }
}
