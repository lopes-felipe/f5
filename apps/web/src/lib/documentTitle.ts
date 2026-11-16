import { APP_BASE_NAME, APP_DISPLAY_NAME } from "../branding";

/**
 * Single owner of `document.title`: routes set the page part and
 * thread attention sets the `(n)` prefix, so neither overwrites the other.
 * The desktop shell composes the native window title from this value.
 */
let pageTitle: string | null = null;
let attentionCount = 0;

export function composeDocumentTitle(page: string | null, count: number): string {
  const trimmed = page?.trim() ?? "";
  const base = trimmed.length > 0 ? `${trimmed} · ${APP_BASE_NAME}` : APP_DISPLAY_NAME;
  return count > 0 ? `(${count}) ${base}` : base;
}

function applyDocumentTitle(): void {
  if (typeof document === "undefined") return;
  const next = composeDocumentTitle(pageTitle, attentionCount);
  if (document.title !== next) document.title = next;
}

export function setDocumentPageTitle(page: string | null): void {
  pageTitle = page;
  applyDocumentTitle();
}

export function setDocumentAttentionCount(count: number): void {
  attentionCount = Number.isFinite(count) ? Math.max(0, Math.floor(count)) : 0;
  applyDocumentTitle();
}
