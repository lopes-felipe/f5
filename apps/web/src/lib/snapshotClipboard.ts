import { setAttachmentSource } from "./attachmentUploadQueue";
import { safeLocalStorageGetItem, safeLocalStorageSetItem } from "./safeStorage";

const marker = "data-f5-snapshot";
const snapshotImageName = /^(window(?:-[a-f0-9-]+)?)\.(?:png|webp)$/i;
export const SNAPSHOT_CONTEXT_MAX_CHARS = 20_000;
const receiptKey = "f5:snapshot-clipboard-receipts";
const recentFragments = new Set<string>();
const receiptLimit = 16;

function readReceipts(): readonly string[] {
  try {
    const value: unknown = JSON.parse(safeLocalStorageGetItem(receiptKey) ?? "[]");
    if (Array.isArray(value))
      return value.filter((entry): entry is string => typeof entry === "string");
  } catch {
    // Copy and paste within this window works with storage disabled.
  }
  return [];
}

async function fragmentReceipt(encoded: string): Promise<string | undefined> {
  try {
    const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(encoded));
    return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("");
  } catch {
    return undefined;
  }
}

async function rememberFragment(encoded: string): Promise<void> {
  recentFragments.add(encoded);
  if (recentFragments.size > receiptLimit) {
    const oldest = recentFragments.values().next().value;
    if (oldest !== undefined) recentFragments.delete(oldest);
  }
  const receipt = await fragmentReceipt(encoded);
  if (!receipt) return;
  safeLocalStorageSetItem(
    receiptKey,
    JSON.stringify([...readReceipts(), receipt].slice(-receiptLimit)),
  );
}

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
  const stem = snapshotImageName.exec(image.name)?.[1];
  if (image.source !== "snapshot" || !stem) return;
  if (attachments.filter(({ name }) => name === image.name).length !== 1) return;
  const name = stem + "-context.txt";
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
    JSON.stringify({
      version: 1,
      name,
      nonce: Array.from(crypto.getRandomValues(new Uint8Array(16))),
      context: context?.slice(0, SNAPSHOT_CONTEXT_MAX_CHARS),
    }),
  ).replaceAll("'", "%27");
  await rememberFragment(fragment);
  return `<span ${marker}='${fragment}'>F5 Snap Shot</span>`;
}

export async function restoreClipboardSnapshot(
  files: File[],
  clipboard: DataTransfer,
): Promise<File[]> {
  if (files.length !== 1 || files[0]?.type !== "image/png") return files;
  const html = clipboard.getData("text/html").slice(0, 256_000);
  const encoded = /<span\b[^>]*\bdata-f5-snapshot=["']([^"']{1,250000})["']/i.exec(html)?.[1];
  if (!encoded) return files;
  if (!recentFragments.has(encoded)) {
    const receipt = await fragmentReceipt(encoded);
    if (!receipt || !readReceipts().includes(receipt)) return files;
  }
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
    const stem = fragment.name.replace(/\.[^.]+$/, "");
    const image = setAttachmentSource(
      new File(files, stem + ".png", { type: "image/png" }),
      "snapshot",
    );
    return typeof fragment.context === "string" &&
      fragment.context.length <= SNAPSHOT_CONTEXT_MAX_CHARS
      ? [
          image,
          setAttachmentSource(
            new File([fragment.context], stem + "-context.txt", {
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
