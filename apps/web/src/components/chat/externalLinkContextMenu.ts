import type { ContextMenuItem } from "@t3tools/contracts";

export type ExternalLinkContextMenuAction = "open-in-preview" | "open-external" | "copy-link";

/** Only http(s) links get the link menu; other schemes keep the default menu. */
export function isExternalWebLink(href: string | undefined): href is string {
  if (!href) return false;
  try {
    const { protocol } = new URL(href);
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

export function externalLinkContextMenuItems(
  canOpenInPreview: boolean,
): ContextMenuItem<ExternalLinkContextMenuAction>[] {
  return [
    ...(canOpenInPreview
      ? [{ id: "open-in-preview" as const, label: "Open in integrated browser" }]
      : []),
    { id: "open-external", label: "Open in system browser" },
    { id: "copy-link", label: "Copy Link" },
  ];
}

export async function showExternalLinkContextMenu(input: {
  href: string;
  position: { x: number; y: number };
  canOpenInPreview: boolean;
  showContextMenu: (
    items: readonly ContextMenuItem<ExternalLinkContextMenuAction>[],
    position: { x: number; y: number },
  ) => Promise<ExternalLinkContextMenuAction | null>;
  openInPreview: (href: string) => Promise<void>;
  openExternal: (href: string) => Promise<void>;
  copyLink: (href: string) => Promise<void>;
  onCopyFailure: (cause: unknown) => void;
}): Promise<void> {
  const action = await input
    .showContextMenu(externalLinkContextMenuItems(input.canOpenInPreview), input.position)
    .catch(() => null);
  if (action === "open-in-preview") {
    await input.openInPreview(input.href).catch(() => undefined);
  } else if (action === "open-external") {
    await input.openExternal(input.href).catch(() => undefined);
  } else if (action === "copy-link") {
    await input.copyLink(input.href).catch(input.onCopyFailure);
  }
}
