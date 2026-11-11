export function shouldHideCollapsedToastContent(
  visibleToastIndex: number,
  visibleToastCount: number,
): boolean {
  // Keep the front-most toast readable even if Base UI marks it as "behind"
  // due to toasts hidden by thread filtering.
  if (visibleToastCount <= 1) return false;
  return visibleToastIndex > 0;
}

type ToastWithHeight = {
  height?: number | null | undefined;
};

type VisibleToastLayoutItem<TToast extends object> = {
  toast: TToast;
  visibleIndex: number;
  offsetY: number;
};

export function buildVisibleToastLayout<TToast extends object>(
  visibleToasts: readonly (TToast & ToastWithHeight)[],
): {
  frontmostHeight: number;
  items: VisibleToastLayoutItem<TToast & ToastWithHeight>[];
} {
  let offsetY = 0;

  return {
    frontmostHeight: normalizeToastHeight(visibleToasts[0]?.height),
    items: visibleToasts.map((toast, visibleIndex) => {
      const item = {
        toast,
        visibleIndex,
        offsetY,
      };

      offsetY += normalizeToastHeight(toast.height);
      return item;
    }),
  };
}

function normalizeToastHeight(height: number | null | undefined): number {
  return typeof height === "number" && Number.isFinite(height) && height > 0 ? height : 0;
}

/** The provider default; error and warning toasts stay longer. */
export const DEFAULT_TOAST_TIMEOUT_MS = 4_000;

export function defaultToastTimeout(type: string | undefined): number {
  if (type === "error") return 8_000;
  if (type === "warning") return 6_000;
  return DEFAULT_TOAST_TIMEOUT_MS;
}

type DedupeCandidate = {
  id?: string | undefined;
  type?: string | undefined;
  title?: unknown;
  description?: unknown;
  actionProps?: unknown;
  data?:
    | {
        dedupeKey?: string | undefined;
        threadId?: string | null | undefined;
        actions?: readonly unknown[] | undefined;
      }
    | undefined;
};

/**
 * Identical toasts collapse into one with a count. Only plain-text toasts are keyed: a React
 * node cannot be compared, a caller-chosen id means the caller manages the toast itself, and
 * loading toasts are progress that a later update resolves. A toast with actions is only merged
 * under an explicit key: its buttons act on its own payload, which a merge would drop.
 */
export function toastDedupeKey(options: DedupeCandidate): string | null {
  if (options.data?.dedupeKey) return options.data.dedupeKey;
  if (options.id !== undefined || options.type === "loading") return null;
  if (options.actionProps !== undefined || (options.data?.actions?.length ?? 0) > 0) return null;
  if (typeof options.title !== "string") return null;
  const description =
    options.description === undefined || options.description === null
      ? ""
      : typeof options.description === "string"
        ? options.description
        : null;
  if (description === null) return null;
  return [options.type ?? "", options.data?.threadId ?? "", options.title, description].join(
    "\u0000",
  );
}

/** "now", "3m", "2h", "4d": the compact time macOS shows on a notification. */
export function formatToastAge(createdAtMs: number, nowMs: number): string {
  const seconds = Math.max(0, Math.floor((nowMs - createdAtMs) / 1000));
  if (seconds < 60) return "now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

export const TOAST_MIN_TOP_OFFSET_PX = 52;
const TOAST_AVOID_GAP_PX = 8;

type AvoidRect = {
  top: number;
  bottom: number;
  left: number;
  right: number;
  width: number;
  height: number;
};

/**
 * The stack starts below any visible `[data-toast-avoid]` element in the right half of the
 * window (the header runtime strip), and never above the header.
 */
export function resolveToastTopOffset(rects: readonly AvoidRect[], viewportWidth: number): number {
  let offset = TOAST_MIN_TOP_OFFSET_PX;
  for (const rect of rects) {
    if (rect.width <= 0 || rect.height <= 0) continue;
    if (rect.right <= viewportWidth / 2) continue;
    // Only elements near the top can push the stack down; a low element would push it off screen.
    if (rect.top > 160) continue;
    offset = Math.max(offset, Math.ceil(rect.bottom + TOAST_AVOID_GAP_PX));
  }
  return offset;
}
