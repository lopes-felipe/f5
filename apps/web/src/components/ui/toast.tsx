"use client";

import { threadStatusIcon, type ThreadStatus } from "../../threadStatus";
import { Toast } from "@base-ui/react/toast";
import type {
  ToastManagerAddOptions,
  ToastManagerPromiseOptions,
  ToastManagerUpdateOptions,
} from "@base-ui/react/toast";
import {
  useEffect,
  useState,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
  type MouseEventHandler,
  type ReactNode,
} from "react";
import { useParams } from "@tanstack/react-router";
import { ThreadId } from "@t3tools/contracts";
import {
  CalendarClockIcon,
  CircleAlertIcon,
  CircleCheckIcon,
  CopyIcon,
  DownloadIcon,
  GitMergeIcon,
  GitPullRequestIcon,
  InfoIcon,
  LoaderCircleIcon,
  TriangleAlertIcon,
  XIcon,
  type LucideIcon,
} from "lucide-react";

import { cn } from "~/lib/utils";
import { buttonVariants } from "~/components/ui/button";
import { writeTextToClipboard } from "~/hooks/useCopyToClipboard";
import {
  buildVisibleToastLayout,
  DEFAULT_TOAST_TIMEOUT_MS,
  defaultToastTimeout,
  formatToastAge,
  resolveToastTopOffset,
  shouldHideCollapsedToastContent,
  TOAST_MIN_TOP_OFFSET_PX,
  toastDedupeKey,
} from "./toast.logic";

export type ToastSource =
  | "thread"
  | "pr"
  | "scheduled"
  | "upstream"
  | "update"
  | "errors"
  | "system";

export type ToastItemTone = "warning" | "destructive" | "info" | "success" | "muted";

/** A clickable row inside a grouped toast, such as one pull request of a batch. */
export type ToastItem = {
  id: string;
  label: ReactNode;
  trailing?: ReactNode;
  tone?: ToastItemTone;
  onSelect: () => void;
};

/**
 * A toast button. The toast closes after `onClick` unless `keepOpen` is set, the handler
 * rejects, or it calls `event.preventDefault()`. A returned promise disables the buttons while
 * it is pending.
 */
export type ToastActionSpec = {
  label: ReactNode;
  variant?: "primary" | "secondary";
  onClick: (event: ReactMouseEvent<HTMLButtonElement>) => void | Promise<void>;
  keepOpen?: boolean;
};

export type AppToastData = {
  threadStatus?: ThreadStatus;
  /** Scopes the toast to one thread: it only renders while that thread is open. */
  threadId?: ThreadId | null;
  tooltipStyle?: boolean;
  dismissAfterVisibleMs?: number;
  source?: ToastSource;
  /** A muted line under the title, such as "f5 · Thread title". */
  sourceLabel?: string;
  /** A single-line monospace block: a command, a path, an error code. */
  detail?: string;
  items?: readonly ToastItem[];
  moreCount?: number;
  /** Approvals and input requests: actions always show and the toast never times out. */
  urgent?: boolean;
  /** How many identical toasts this one stands for. */
  count?: number;
  dedupeKey?: string;
  createdAt?: number;
  actions?: readonly ToastActionSpec[];
  /** What "Copy details" puts on the clipboard; set on error toasts automatically. */
  copyText?: string;
};

/** @deprecated Use `AppToastData`. */
export type ThreadToastData = AppToastData;

const baseToastManager = Toast.createToastManager<AppToastData>();
const anchoredToastManager = Toast.createToastManager<AppToastData>();
type ToastId = ReturnType<typeof baseToastManager.add>;
const threadToastVisibleTimeoutRemainingMs = new Map<ToastId, number>();

/** Listeners told about every toast added through `toastManager` (the notification inbox). */
type ToastAddListener = (options: ToastManagerAddOptions<AppToastData>, id: string) => void;
const toastAddListeners = new Set<ToastAddListener>();

export function subscribeToastAdds(listener: ToastAddListener): () => void {
  toastAddListeners.add(listener);
  return () => {
    toastAddListeners.delete(listener);
  };
}

let toastSequence = 0;

function textOf(node: ReactNode): string | null {
  if (typeof node === "string") return node;
  if (typeof node === "number") return String(node);
  return null;
}

function buildCopyText(title: ReactNode, description: ReactNode, createdAt: number): string | null {
  const titleText = textOf(title);
  if (!titleText) return null;
  const descriptionText = textOf(description);
  return [titleText, descriptionText, new Date(createdAt).toISOString()]
    .filter((part): part is string => Boolean(part))
    .join("\n\n");
}

/**
 * The app's toast manager. Same API as Base UI's, plus: identical plain-text toasts collapse
 * into one with a count and a fresh timeout, errors and warnings stay longer, and error toasts
 * can copy their details.
 */
export function createAppToastManager(base: typeof baseToastManager) {
  // `rendered` turns true once the stack has shown the toast; a rendered toast that is no
  // longer in the stack is gone even if its close callback never ran (an unmounted provider).
  const openByKey = new Map<string, { id: string; count: number; rendered: boolean }>();

  function resolveData(
    options: ToastManagerAddOptions<AppToastData>,
    createdAt: number,
    extra: Partial<AppToastData>,
  ): AppToastData {
    const data: AppToastData = { ...options.data, createdAt, ...extra };
    if (options.type === "error" && data.copyText === undefined) {
      const copyText = buildCopyText(options.title, options.description, createdAt);
      if (copyText) data.copyText = copyText;
    }
    return data;
  }

  return {
    " subscribe": base[" subscribe"],
    add(options: ToastManagerAddOptions<AppToastData>): string {
      const key = toastDedupeKey(options);
      const timeout =
        options.timeout ?? (options.data?.urgent ? 0 : defaultToastTimeout(options.type));
      const createdAt = Date.now();
      const existing = key ? openByKey.get(key) : undefined;
      if (existing) {
        existing.count += 1;
        const { onClose: _onClose, onRemove: _onRemove, id: _id, ...rest } = options;
        base.update(existing.id, {
          ...rest,
          timeout,
          data: resolveData(options, createdAt, { count: existing.count, dedupeKey: key! }),
        });
        for (const listener of toastAddListeners) listener(options, existing.id);
        return existing.id;
      }
      toastSequence += 1;
      const id = options.id ?? `app-toast-${toastSequence}`;
      const forget = () => {
        if (key && openByKey.get(key)?.id === id) openByKey.delete(key);
      };
      if (key) openByKey.set(key, { id, count: 1, rendered: false });
      base.add({
        ...options,
        id,
        timeout,
        data: resolveData(options, createdAt, key ? { dedupeKey: key } : {}),
        onClose: () => {
          forget();
          options.onClose?.();
        },
        onRemove: () => {
          forget();
          options.onRemove?.();
        },
      });
      for (const listener of toastAddListeners) listener(options, id);
      return id;
    },
    close(id?: string): void {
      base.close(id);
    },
    /** Called by the stack with the toasts it holds, so dedupe never targets a vanished one. */
    syncRendered(ids: ReadonlySet<string>): void {
      for (const [key, entry] of openByKey) {
        if (ids.has(entry.id)) entry.rendered = true;
        else if (entry.rendered) openByKey.delete(key);
      }
    },
    /** The stack unmounted and its toasts with it. */
    reset(): void {
      openByKey.clear();
    },
    update(id: string, updates: ToastManagerUpdateOptions<AppToastData>): void {
      base.update(id, updates);
    },
    promise<Value>(
      promiseValue: Promise<Value>,
      options: ToastManagerPromiseOptions<Value, AppToastData>,
    ): Promise<Value> {
      return base.promise(promiseValue, options);
    },
  };
}

const toastManager = createAppToastManager(baseToastManager);

type ToastTileVisual = { Icon: LucideIcon; className: string };

const TYPE_TILES: Record<string, ToastTileVisual> = {
  error: { Icon: CircleAlertIcon, className: "bg-destructive text-white" },
  warning: { Icon: TriangleAlertIcon, className: "bg-warning text-white" },
  success: { Icon: CircleCheckIcon, className: "bg-success text-white" },
  info: { Icon: InfoIcon, className: "bg-info text-white" },
  loading: { Icon: LoaderCircleIcon, className: "bg-secondary text-muted-foreground" },
};

const SOURCE_TILES: Partial<Record<ToastSource, ToastTileVisual>> = {
  pr: { Icon: GitPullRequestIcon, className: "bg-warning text-white" },
  scheduled: { Icon: CalendarClockIcon, className: "bg-primary text-primary-foreground" },
  upstream: { Icon: GitMergeIcon, className: "bg-secondary text-foreground" },
  update: { Icon: DownloadIcon, className: "bg-primary text-primary-foreground" },
  errors: TYPE_TILES.error!,
};

function threadStatusTileClass(status: ThreadStatus): string {
  switch (status) {
    case "pending-approval":
    case "awaiting-input":
    case "plan-ready":
      return "bg-info text-white";
    case "failed":
      return "bg-destructive text-white";
    case "completed":
      return "bg-success text-white";
    default:
      return "bg-secondary text-foreground";
  }
}

export function resolveToastTile(
  type: string | undefined,
  data: AppToastData | undefined,
): ToastTileVisual | null {
  if (data?.threadStatus) {
    const Icon = threadStatusIcon(data.threadStatus);
    if (Icon) return { Icon, className: threadStatusTileClass(data.threadStatus) };
  }
  if (data?.source) {
    const visual = SOURCE_TILES[data.source];
    if (visual) return visual;
  }
  return (type && TYPE_TILES[type]) || null;
}

function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(timer);
  }, [intervalMs]);
  return now;
}

function ToastTile({ visual, spinning }: { visual: ToastTileVisual | null; spinning: boolean }) {
  if (!visual) return null;
  const { Icon } = visual;
  return (
    <div
      className={cn(
        "flex size-8 shrink-0 items-center justify-center rounded-lg",
        visual.className,
      )}
      data-slot="toast-icon"
    >
      <Icon className={cn("size-4", spinning && "animate-spin")} aria-hidden />
    </div>
  );
}

const ITEM_TONE_CLASS: Record<ToastItemTone, string> = {
  warning: "bg-warning",
  destructive: "bg-destructive",
  info: "bg-info",
  success: "bg-success",
  muted: "bg-faint-foreground",
};

function ToastItems({
  items,
  moreCount,
  closeToast,
}: {
  items: readonly ToastItem[];
  moreCount: number | undefined;
  closeToast: () => void;
}) {
  return (
    <div className="-mx-1 border-t border-foreground/8 pt-1" data-slot="toast-items">
      {items.map((item) => (
        <button
          key={item.id}
          type="button"
          className="flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs outline-none transition-colors hover:bg-foreground/7 focus-visible:bg-foreground/7"
          data-slot="toast-item"
          onClick={() => {
            item.onSelect();
            closeToast();
          }}
        >
          <span
            aria-hidden
            className={cn("size-1.5 shrink-0 rounded-full", ITEM_TONE_CLASS[item.tone ?? "muted"])}
          />
          <span className="min-w-0 flex-1 truncate font-mono text-foreground">{item.label}</span>
          {item.trailing ? (
            <span className="shrink-0 text-muted-foreground">{item.trailing} ›</span>
          ) : null}
        </button>
      ))}
      {moreCount && moreCount > 0 ? (
        <div className="px-2 py-1 text-xs text-muted-foreground">+ {moreCount} more</div>
      ) : null}
    </div>
  );
}

type ToastActionConfig = {
  children?: ReactNode | undefined;
  className?: string | undefined;
  onClick?: MouseEventHandler<HTMLButtonElement> | undefined;
};

function ToastActions({
  actions,
  actionProps,
  closeToast,
}: {
  actions: readonly ToastActionSpec[];
  actionProps: ToastActionConfig | undefined;
  closeToast: () => void;
}) {
  const [pending, setPending] = useState(false);
  if (actions.length === 0 && !actionProps) return null;
  const run = (spec: ToastActionSpec, event: ReactMouseEvent<HTMLButtonElement>) => {
    let result: void | Promise<void>;
    try {
      result = spec.onClick(event);
    } catch {
      return;
    }
    if (result && typeof (result as Promise<void>).then === "function") {
      setPending(true);
      void (result as Promise<void>).then(
        () => {
          setPending(false);
          if (!spec.keepOpen) closeToast();
        },
        () => setPending(false),
      );
      return;
    }
    if (!spec.keepOpen && !event.defaultPrevented) closeToast();
  };
  return (
    <div className="flex gap-1.5" data-slot="toast-actions">
      {actions.map((spec, index) => (
        <button
          key={index}
          type="button"
          disabled={pending}
          className={cn(
            buttonVariants({
              size: "xs",
              variant: spec.variant === "primary" ? "default" : "secondary",
            }),
            "min-w-0 flex-1 rounded-lg",
          )}
          data-slot="toast-action"
          onClick={(event) => run(spec, event)}
        >
          {spec.label}
        </button>
      ))}
      {actionProps ? (
        <Toast.Action
          className={cn(
            buttonVariants({ size: "xs", variant: actions.length > 0 ? "secondary" : "default" }),
            "min-w-0 flex-1 rounded-lg",
            actionProps.className,
          )}
          data-slot="toast-action"
          onClick={(event) => {
            actionProps.onClick?.(event);
            if (!event.defaultPrevented) closeToast();
          }}
        >
          {actionProps.children}
        </Toast.Action>
      ) : null}
    </div>
  );
}

const toastCloseBadgeClassName =
  "absolute -top-1.5 -left-1.5 z-10 inline-flex size-5 items-center justify-center rounded-full border border-foreground/10 bg-popover text-muted-foreground opacity-0 shadow-sm transition-opacity duration-(--duration-fast) group-hover/toast:opacity-100 group-focus-within/toast:opacity-100 hover:text-foreground focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

function ToastCloseBadge() {
  return (
    <Toast.Close aria-label="Dismiss" className={toastCloseBadgeClassName} data-slot="toast-close">
      <XIcon className="size-3" />
    </Toast.Close>
  );
}

function CopyDetailsButton({ text }: { text: string }) {
  return (
    <button
      type="button"
      aria-label="Copy details"
      title="Copy details"
      className="hidden size-5 shrink-0 items-center justify-center rounded-md text-muted-foreground outline-none hover:text-foreground focus-visible:flex focus-visible:ring-2 focus-visible:ring-ring group-hover/toast:flex group-focus-within/toast:flex"
      data-slot="toast-copy"
      onClick={() => {
        void writeTextToClipboard(text).then(
          () => toastManager.add({ type: "success", title: "Error details copied" }),
          () => undefined,
        );
      }}
    >
      <CopyIcon className="size-3.5" />
    </button>
  );
}

/** The card body shared by stacked and anchored toasts. */
function ToastCardBody({
  type,
  data,
  actionProps,
  closeToast,
}: {
  type: string | undefined;
  data: AppToastData | undefined;
  actionProps: ToastActionConfig | undefined;
  closeToast: () => void;
}) {
  const now = useNow(30_000);
  const [expanded, setExpanded] = useState(false);
  const visual = resolveToastTile(type, data);
  const count = data?.count ?? 1;
  const items = data?.items ?? [];
  const actions = data?.actions ?? [];
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <div className="flex min-w-0 gap-2.5">
        <ToastTile visual={visual} spinning={type === "loading"} />
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex min-w-0 items-start gap-2">
            <Toast.Title
              className="line-clamp-2 min-w-0 flex-1 break-words font-semibold"
              data-slot="toast-title"
            />
            {count > 1 ? (
              <span
                className="mt-0.5 shrink-0 rounded-full bg-foreground/10 px-1.5 text-2xs font-semibold tabular-nums"
                data-slot="toast-count"
              >
                ×{count}
              </span>
            ) : null}
            {data?.copyText ? <CopyDetailsButton text={data.copyText} /> : null}
            {data?.createdAt ? (
              <span
                className={cn(
                  "mt-0.5 shrink-0 text-2xs text-muted-foreground tabular-nums",
                  data.copyText && "group-hover/toast:hidden group-focus-within/toast:hidden",
                )}
                data-slot="toast-time"
              >
                {formatToastAge(data.createdAt, now)}
              </span>
            ) : null}
          </div>
          {data?.sourceLabel ? (
            <div className="truncate text-2xs text-muted-foreground" data-slot="toast-source">
              {data.sourceLabel}
            </div>
          ) : null}
          <Toast.Description
            className={cn("min-w-0 break-words text-muted-foreground", !expanded && "line-clamp-3")}
            data-slot="toast-description"
            onClick={() => setExpanded((value) => !value)}
          />
          {data?.detail ? (
            <div
              className="mt-1.5 truncate rounded-md bg-foreground/6 px-2 py-1 font-mono text-xs text-foreground"
              data-slot="toast-detail"
              title={data.detail}
            >
              {data.detail}
            </div>
          ) : null}
        </div>
      </div>
      {items.length > 0 ? (
        <ToastItems items={items} moreCount={data?.moreCount} closeToast={closeToast} />
      ) : null}
      <ToastActions actions={actions} actionProps={actionProps} closeToast={closeToast} />
    </div>
  );
}

type ToastPosition =
  | "top-left"
  | "top-center"
  | "top-right"
  | "bottom-left"
  | "bottom-center"
  | "bottom-right";

interface ToastProviderProps extends Toast.Provider.Props {
  position?: ToastPosition;
}

function shouldRenderForActiveThread(
  data: AppToastData | undefined,
  activeThreadId: ThreadId | null,
): boolean {
  const toastThreadId = data?.threadId;
  if (!toastThreadId) return true;
  return toastThreadId === activeThreadId;
}

function useActiveThreadIdFromRoute(): ThreadId | null {
  return useParams({
    strict: false,
    select: (params) =>
      typeof params.threadId === "string" ? ThreadId.makeUnsafe(params.threadId) : null,
  });
}

/**
 * Keeps the stack below the header runtime strip and anything else marked
 * `data-toast-avoid`, as it appears, resizes or goes away.
 */
function useToastTopOffset(enabled: boolean): number {
  const [offset, setOffset] = useState(TOAST_MIN_TOP_OFFSET_PX);
  useEffect(() => {
    if (!enabled || typeof document === "undefined") return;
    let frame = 0;
    const resizeObserver =
      typeof ResizeObserver === "function" ? new ResizeObserver(() => schedule()) : null;
    let observed = new Set<Element>();
    const measure = () => {
      frame = 0;
      const elements = Array.from(document.querySelectorAll("[data-toast-avoid]"));
      const next = new Set(elements);
      for (const element of observed) if (!next.has(element)) resizeObserver?.unobserve(element);
      for (const element of next) if (!observed.has(element)) resizeObserver?.observe(element);
      observed = next;
      setOffset(
        resolveToastTopOffset(
          elements.map((element) => element.getBoundingClientRect()),
          window.innerWidth,
        ),
      );
    };
    function schedule() {
      if (frame === 0) frame = window.requestAnimationFrame(measure);
    }
    const mutationObserver = new MutationObserver(schedule);
    mutationObserver.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["data-toast-avoid"],
    });
    window.addEventListener("resize", schedule);
    measure();
    return () => {
      if (frame !== 0) window.cancelAnimationFrame(frame);
      mutationObserver.disconnect();
      resizeObserver?.disconnect();
      window.removeEventListener("resize", schedule);
    };
  }, [enabled]);
  return offset;
}

function ThreadToastVisibleAutoDismiss({
  toastId,
  dismissAfterVisibleMs,
}: {
  toastId: ToastId;
  dismissAfterVisibleMs: number | undefined;
}) {
  useEffect(() => {
    if (!dismissAfterVisibleMs || dismissAfterVisibleMs <= 0) return;
    if (typeof window === "undefined" || typeof document === "undefined") return;

    let remainingMs = threadToastVisibleTimeoutRemainingMs.get(toastId) ?? dismissAfterVisibleMs;
    let startedAtMs: number | null = null;
    let timeoutId: number | null = null;
    let closed = false;

    const clearTimer = () => {
      if (timeoutId === null) return;
      window.clearTimeout(timeoutId);
      timeoutId = null;
    };

    const closeToast = () => {
      if (closed) return;
      closed = true;
      threadToastVisibleTimeoutRemainingMs.delete(toastId);
      toastManager.close(toastId);
    };

    const pause = () => {
      if (startedAtMs === null) return;
      remainingMs = Math.max(0, remainingMs - (Date.now() - startedAtMs));
      startedAtMs = null;
      clearTimer();
      threadToastVisibleTimeoutRemainingMs.set(toastId, remainingMs);
    };

    const start = () => {
      if (closed || startedAtMs !== null) return;
      if (remainingMs <= 0) {
        closeToast();
        return;
      }
      startedAtMs = Date.now();
      clearTimer();
      timeoutId = window.setTimeout(() => {
        remainingMs = 0;
        startedAtMs = null;
        closeToast();
      }, remainingMs);
    };

    const syncTimer = () => {
      const shouldRun = document.visibilityState === "visible" && document.hasFocus();
      if (shouldRun) {
        start();
        return;
      }
      pause();
    };

    syncTimer();
    document.addEventListener("visibilitychange", syncTimer);
    window.addEventListener("focus", syncTimer);
    window.addEventListener("blur", syncTimer);

    return () => {
      document.removeEventListener("visibilitychange", syncTimer);
      window.removeEventListener("focus", syncTimer);
      window.removeEventListener("blur", syncTimer);
      pause();
      clearTimer();
    };
  }, [dismissAfterVisibleMs, toastId]);

  return null;
}

function ToastProvider({ children, position = "top-right", ...props }: ToastProviderProps) {
  return (
    <Toast.Provider toastManager={baseToastManager} timeout={DEFAULT_TOAST_TIMEOUT_MS} {...props}>
      {children}
      <Toasts position={position} />
    </Toast.Provider>
  );
}

function Toasts({ position = "top-right" }: { position: ToastPosition }) {
  const { toasts } = Toast.useToastManager<AppToastData>();
  const activeThreadId = useActiveThreadIdFromRoute();
  const isTop = position.startsWith("top");
  const topOffset = useToastTopOffset(isTop);
  const visibleToasts = toasts.filter((toast) =>
    shouldRenderForActiveThread(toast.data, activeThreadId),
  );
  const visibleToastLayout = buildVisibleToastLayout(visibleToasts);

  useEffect(() => {
    const activeToastIds = new Set(toasts.map((toast) => toast.id));
    toastManager.syncRendered(activeToastIds);
    for (const toastId of threadToastVisibleTimeoutRemainingMs.keys()) {
      if (!activeToastIds.has(toastId)) {
        threadToastVisibleTimeoutRemainingMs.delete(toastId);
      }
    }
  }, [toasts]);
  useEffect(() => () => toastManager.reset(), []);

  return (
    <Toast.Portal data-slot="toast-portal">
      <Toast.Viewport
        className={cn(
          "fixed z-50 mx-auto flex w-[calc(100%-var(--toast-inset)*2)] max-w-86 [--toast-inset:--spacing(3)] sm:[--toast-inset:--spacing(4)]",
          // Vertical positioning: below the header and its runtime strip.
          "data-[position*=top]:top-(--toast-top)",
          "data-[position*=bottom]:bottom-(--toast-inset)",
          // Horizontal positioning
          "data-[position*=left]:left-(--toast-inset)",
          "data-[position*=right]:right-(--toast-inset)",
          "data-[position*=center]:-translate-x-1/2 data-[position*=center]:left-1/2",
        )}
        data-position={position}
        data-slot="toast-viewport"
        style={
          {
            "--toast-frontmost-height": `${visibleToastLayout.frontmostHeight}px`,
            "--toast-top": `${topOffset}px`,
          } as CSSProperties
        }
      >
        {visibleToastLayout.items.map(({ toast, visibleIndex, offsetY }) => {
          const hideCollapsedContent = shouldHideCollapsedToastContent(
            visibleIndex,
            visibleToastLayout.items.length,
          );

          return (
            <Toast.Root
              data-slot="toast-root"
              data-urgent={toast.data?.urgent ? "" : undefined}
              className={cn(
                "group/toast surface-notification absolute z-[calc(9999-var(--toast-index))] h-(--toast-calc-height) w-full select-none rounded-2xl text-popover-foreground [transition:transform_.5s_cubic-bezier(.22,1,.36,1),opacity_.5s,height_.15s]",
                // Base positioning using data-position
                "data-[position*=right]:right-0 data-[position*=right]:left-auto",
                "data-[position*=left]:right-auto data-[position*=left]:left-0",
                "data-[position*=center]:right-0 data-[position*=center]:left-0",
                "data-[position*=top]:top-0 data-[position*=top]:bottom-auto data-[position*=top]:origin-top",
                "data-[position*=bottom]:top-auto data-[position*=bottom]:bottom-0 data-[position*=bottom]:origin-bottom",
                // Gap fill for hover
                "after:absolute after:left-0 after:h-[calc(var(--toast-gap)+1px)] after:w-full",
                "data-[position*=top]:after:top-full",
                "data-[position*=bottom]:after:bottom-full",
                // Define some variables
                // Base UI exposes a shared front-most height for the collapsed stack.
                // If that shared measurement is briefly stale, long content can render
                // outside the card until hover expands the toast and swaps to its own height.
                // Behind the front card, macOS-style slivers: a small peek and a gentle shrink.
                "[--toast-calc-height:max(var(--toast-frontmost-height,var(--toast-height)),var(--toast-height))] [--toast-gap:--spacing(2)] [--toast-peek:--spacing(2)] [--toast-scale:calc(max(0,1-(var(--toast-index)*.05)))] [--toast-shrink:calc(1-var(--toast-scale))]",
                // Define offset-y variable
                "data-[position*=top]:[--toast-calc-offset-y:calc(var(--toast-offset-y)+var(--toast-index)*var(--toast-gap)+var(--toast-swipe-movement-y))]",
                "data-[position*=bottom]:[--toast-calc-offset-y:calc(var(--toast-offset-y)*-1+var(--toast-index)*var(--toast-gap)*-1+var(--toast-swipe-movement-y))]",
                // Default state transform
                "data-[position*=top]:transform-[translateX(var(--toast-swipe-movement-x))_translateY(calc(var(--toast-swipe-movement-y)+(var(--toast-index)*var(--toast-peek))+(var(--toast-shrink)*var(--toast-calc-height))))_scale(var(--toast-scale))]",
                "data-[position*=bottom]:transform-[translateX(var(--toast-swipe-movement-x))_translateY(calc(var(--toast-swipe-movement-y)-(var(--toast-index)*var(--toast-peek))-(var(--toast-shrink)*var(--toast-calc-height))))_scale(var(--toast-scale))]",
                // Limited state
                "data-limited:opacity-0",
                // Expanded state
                "data-expanded:h-(--toast-height)",
                "data-position:data-expanded:transform-[translateX(var(--toast-swipe-movement-x))_translateY(var(--toast-calc-offset-y))]",
                // Starting and ending animations: slide in from the right edge.
                "data-[position*=top]:data-starting-style:transform-[translateY(calc(-100%-var(--toast-inset)))]",
                "data-[position*=bottom]:data-starting-style:transform-[translateY(calc(100%+var(--toast-inset)))]",
                "data-[position*=right]:data-starting-style:transform-[translateX(calc(100%+var(--toast-inset)))_translateY(var(--toast-calc-offset-y))]",
                "data-ending-style:opacity-0",
                // Ending animations (direction-aware)
                "data-ending-style:not-data-limited:not-data-swipe-direction:transform-[translateY(calc(100%+var(--toast-inset)))]",
                "data-[position*=right]:data-ending-style:not-data-limited:not-data-swipe-direction:transform-[translateX(calc(100%+var(--toast-inset)))_translateY(var(--toast-calc-offset-y))]",
                "data-ending-style:data-[swipe-direction=left]:transform-[translateX(calc(var(--toast-swipe-movement-x)-100%-var(--toast-inset)))_translateY(var(--toast-calc-offset-y))]",
                "data-ending-style:data-[swipe-direction=right]:transform-[translateX(calc(var(--toast-swipe-movement-x)+100%+var(--toast-inset)))_translateY(var(--toast-calc-offset-y))]",
                "data-ending-style:data-[swipe-direction=up]:transform-[translateY(calc(var(--toast-swipe-movement-y)-100%-var(--toast-inset)))]",
                "data-ending-style:data-[swipe-direction=down]:transform-[translateY(calc(var(--toast-swipe-movement-y)+100%+var(--toast-inset)))]",
                // Ending animations (expanded)
                "data-expanded:data-ending-style:data-[swipe-direction=left]:transform-[translateX(calc(var(--toast-swipe-movement-x)-100%-var(--toast-inset)))_translateY(var(--toast-calc-offset-y))]",
                "data-expanded:data-ending-style:data-[swipe-direction=right]:transform-[translateX(calc(var(--toast-swipe-movement-x)+100%+var(--toast-inset)))_translateY(var(--toast-calc-offset-y))]",
                "data-expanded:data-ending-style:data-[swipe-direction=up]:transform-[translateY(calc(var(--toast-swipe-movement-y)-100%-var(--toast-inset)))]",
                "data-expanded:data-ending-style:data-[swipe-direction=down]:transform-[translateY(calc(var(--toast-swipe-movement-y)+100%+var(--toast-inset)))]",
                // Reduced motion: fade only.
                "motion-reduce:[transition:opacity_.2s,height_.15s] motion-reduce:data-starting-style:transform-none motion-reduce:data-ending-style:transform-none",
              )}
              data-position={position}
              key={toast.id}
              style={
                {
                  "--toast-index": visibleIndex,
                  "--toast-offset-y": `${offsetY}px`,
                } as CSSProperties
              }
              swipeDirection={
                position.includes("center")
                  ? [isTop ? "up" : "down"]
                  : position.includes("left")
                    ? ["left", isTop ? "up" : "down"]
                    : ["right", isTop ? "up" : "down"]
              }
              toast={toast}
            >
              <ThreadToastVisibleAutoDismiss
                dismissAfterVisibleMs={toast.data?.dismissAfterVisibleMs}
                toastId={toast.id}
              />
              <Toast.Content
                className={cn(
                  "pointer-events-auto overflow-hidden px-3 py-2.5 text-ui transition-opacity duration-250 data-expanded:opacity-100",
                  hideCollapsedContent &&
                    "not-data-expanded:pointer-events-none not-data-expanded:opacity-0",
                )}
              >
                <ToastCardBody
                  type={toast.type}
                  data={toast.data}
                  actionProps={toast.actionProps}
                  closeToast={() => toastManager.close(toast.id)}
                />
              </Toast.Content>
              <ToastCloseBadge />
            </Toast.Root>
          );
        })}
      </Toast.Viewport>
    </Toast.Portal>
  );
}

function AnchoredToastProvider({ children, ...props }: Toast.Provider.Props) {
  return (
    <Toast.Provider toastManager={anchoredToastManager} {...props}>
      {children}
      <AnchoredToasts />
    </Toast.Provider>
  );
}

function AnchoredToasts() {
  const { toasts } = Toast.useToastManager<AppToastData>();
  const activeThreadId = useActiveThreadIdFromRoute();

  return (
    <Toast.Portal data-slot="toast-portal-anchored">
      <Toast.Viewport className="outline-none" data-slot="toast-viewport-anchored">
        {toasts
          .filter((toast) => shouldRenderForActiveThread(toast.data, activeThreadId))
          .map((toast) => {
            const tooltipStyle = toast.data?.tooltipStyle ?? false;
            const positionerProps = toast.positionerProps;

            if (!positionerProps?.anchor) {
              return null;
            }

            return (
              <Toast.Positioner
                className="z-50 max-w-[min(--spacing(72),var(--available-width))]"
                data-slot="toast-positioner"
                key={toast.id}
                sideOffset={positionerProps.sideOffset ?? 4}
                toast={toast}
              >
                <Toast.Root
                  className={cn(
                    "group/toast relative text-balance text-popover-foreground text-xs transition-[scale,opacity] data-ending-style:scale-98 data-starting-style:scale-98 data-ending-style:opacity-0 data-starting-style:opacity-0",
                    tooltipStyle
                      ? "rounded-md border bg-popover shadow-md/5"
                      : "surface-notification rounded-2xl",
                  )}
                  data-slot="toast-popup"
                  toast={toast}
                >
                  {tooltipStyle ? (
                    <Toast.Content className="pointer-events-auto px-2 py-1">
                      <Toast.Title data-slot="toast-title" />
                    </Toast.Content>
                  ) : (
                    <>
                      <Toast.Content className="pointer-events-auto overflow-hidden px-3 py-2.5 text-ui">
                        <ToastCardBody
                          type={toast.type}
                          data={toast.data}
                          actionProps={toast.actionProps}
                          closeToast={() => anchoredToastManager.close(toast.id)}
                        />
                      </Toast.Content>
                      <ToastCloseBadge />
                    </>
                  )}
                </Toast.Root>
              </Toast.Positioner>
            );
          })}
      </Toast.Viewport>
    </Toast.Portal>
  );
}

export {
  ToastProvider,
  type ToastPosition,
  toastManager,
  AnchoredToastProvider,
  anchoredToastManager,
};
