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
  resolveToastTone,
  resolveToastTopOffset,
  shouldHideCollapsedToastContent,
  TOAST_MIN_TOP_OFFSET_PX,
  toastDedupeKey,
  type ToastTone,
} from "./toast.logic";
import {
  INITIAL_TOAST_WHEEL_STATE,
  stepToastWheel,
  TOAST_WHEEL_IDLE_MS,
  toastWheelProgress,
  type ToastWheelOutward,
  type ToastWheelState,
} from "./toastWheelDismiss.logic";

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

/**
 * Decides on plain error toasts (those not sent through `notify`): records them in the inbox,
 * applies the Errors preferences and Do Not Disturb, and returns whether the toast shows.
 */
export type ErrorToastPolicy = (error: { title: string; body?: string }) => boolean;
let errorToastPolicy: ErrorToastPolicy | null = null;

export function registerErrorToastPolicy(policy: ErrorToastPolicy): () => void {
  errorToastPolicy = policy;
  return () => {
    if (errorToastPolicy === policy) errorToastPolicy = null;
  };
}

function errorToastAllowed(options: ToastManagerAddOptions<AppToastData>): boolean {
  if (options.type !== "error" || options.data?.source || !errorToastPolicy) return true;
  const title = textOf(options.title);
  if (!title) return true;
  const body = textOf(options.description);
  return errorToastPolicy(body ? { title, body } : { title });
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
      if (!errorToastAllowed(options)) {
        // Held back by preferences or Do Not Disturb (still in the inbox). Callers may close or
        // update the id they get; with no such toast that does nothing.
        toastSequence += 1;
        return options.id ?? `app-toast-${toastSequence}`;
      }
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
      return id;
    },
    close(id?: string): void {
      // A closing toast stays mounted while it animates out; a repeat arriving then is new.
      for (const [key, entry] of openByKey) {
        if (id === undefined || entry.id === id) openByKey.delete(key);
      }
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

export type ToastVisual = { Icon: LucideIcon; tone: ToastTone };

const TYPE_ICONS: Partial<Record<string, LucideIcon>> = {
  error: CircleAlertIcon,
  warning: TriangleAlertIcon,
  success: CircleCheckIcon,
  info: InfoIcon,
  loading: LoaderCircleIcon,
};

const SOURCE_ICONS: Partial<Record<ToastSource, LucideIcon>> = {
  pr: GitPullRequestIcon,
  scheduled: CalendarClockIcon,
  upstream: GitMergeIcon,
  update: DownloadIcon,
  errors: CircleAlertIcon,
};

/** The glyph and status colour of a toast or inbox row; same precedence as the tone. */
export function resolveToastVisual(
  type: string | undefined,
  data: Pick<AppToastData, "threadStatus" | "source"> | undefined,
): ToastVisual {
  const statusIcon = data?.threadStatus ? threadStatusIcon(data.threadStatus) : null;
  const Icon =
    statusIcon ??
    (data?.source ? SOURCE_ICONS[data.source] : undefined) ??
    (type ? TYPE_ICONS[type] : undefined) ??
    InfoIcon;
  return { Icon, tone: resolveToastTone(type, data) };
}

const RAIL_TONE_CLASS: Record<ToastTone, string> = {
  warning: "bg-warning",
  attention: "bg-attention",
  info: "bg-info",
  success: "bg-success",
  destructive: "bg-destructive",
  primary: "bg-primary",
  muted: "bg-faint-foreground",
};

const GLYPH_TONE_CLASS: Record<ToastTone, string> = {
  warning: "text-warning-foreground",
  attention: "text-attention-foreground",
  info: "text-info-foreground",
  success: "text-success-foreground",
  destructive: "text-destructive-foreground",
  primary: "text-primary",
  muted: "text-muted-foreground",
};

/** The status-coloured bar on the left edge; its parent must clip and be positioned. */
export function ToastRail({ tone }: { tone: ToastTone }) {
  return (
    <span
      aria-hidden
      className={cn("pointer-events-none absolute inset-y-0 left-0 w-0.75", RAIL_TONE_CLASS[tone])}
      data-slot="toast-rail"
      data-tone={tone}
    />
  );
}

/** The status glyph, centred on the first line of `text-ui` copy. */
export function ToastGlyph({
  visual,
  spinning = false,
  className,
}: {
  visual: ToastVisual;
  spinning?: boolean;
  className?: string;
}) {
  const { Icon } = visual;
  return (
    <span className={cn("flex h-5 shrink-0 items-center", className)} data-slot="toast-icon">
      <Icon
        className={cn("size-4", GLYPH_TONE_CLASS[visual.tone], spinning && "animate-spin")}
        aria-hidden
      />
    </span>
  );
}

function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(timer);
  }, [intervalMs]);
  return now;
}

export const ITEM_TONE_CLASS: Record<ToastItemTone, string> = {
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
    <div className="-mx-2 flex flex-col" data-slot="toast-items">
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
  className,
}: {
  actions: readonly ToastActionSpec[];
  actionProps: ToastActionConfig | undefined;
  closeToast: () => void;
  className?: string;
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
    <div className={cn("flex shrink-0 gap-1.5", className)} data-slot="toast-actions">
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
            "rounded-md",
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
            "rounded-md",
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

/** Solid notification card: the popover surface with a hairline and a soft, deep shadow. */
const toastSurfaceClassName =
  "rounded-lg border border-border bg-popover shadow-[0_2px_6px_rgb(0_0_0/0.06),0_14px_36px_-14px_rgb(0_0_0/0.28)] dark:shadow-[0_2px_6px_rgb(0_0_0/0.35),0_16px_40px_-14px_rgb(0_0_0/0.65)]";

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
function ToastDetail({ text, className }: { text: string; className?: string }) {
  return (
    <div
      className={cn("min-w-0 truncate font-mono text-xs text-muted-foreground", className)}
      data-slot="toast-detail"
      title={text}
    >
      {text}
    </div>
  );
}

/**
 * The card body shared by stacked and anchored toasts: glyph and title on the first line, and
 * everything else indented under the title. A detail (a command, a path) shares its line with
 * the buttons.
 */
function ToastCardBody({
  type,
  data,
  hasDescription,
  actionProps,
  closeToast,
}: {
  type: string | undefined;
  data: AppToastData | undefined;
  hasDescription: boolean;
  actionProps: ToastActionConfig | undefined;
  closeToast: () => void;
}) {
  const now = useNow(30_000);
  const [expanded, setExpanded] = useState(false);
  const visual = resolveToastVisual(type, data);
  const count = data?.count ?? 1;
  const items = data?.items ?? [];
  const actions = data?.actions ?? [];
  const hasActions = actions.length > 0 || actionProps !== undefined;
  const detail = data?.detail;
  const hasText = Boolean(data?.sourceLabel) || hasDescription;
  const hasBody = hasText || Boolean(detail) || items.length > 0 || hasActions;
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <ToastRail tone={visual.tone} />
      <div className="flex min-w-0 items-start gap-2">
        <ToastGlyph visual={visual} spinning={type === "loading"} />
        <Toast.Title
          className="line-clamp-2 min-w-0 flex-1 break-words font-medium"
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
      {hasBody ? (
        <div className="flex min-w-0 flex-col gap-1.5 pl-6" data-slot="toast-body">
          {hasText ? (
            <div className="flex min-w-0 flex-col">
              {data?.sourceLabel ? (
                <div className="truncate text-xs text-muted-foreground" data-slot="toast-source">
                  {data.sourceLabel}
                </div>
              ) : null}
              <Toast.Description
                className={cn(
                  "min-w-0 break-words text-muted-foreground",
                  !expanded && "line-clamp-3",
                )}
                data-slot="toast-description"
                onClick={() => setExpanded((value) => !value)}
              />
            </div>
          ) : null}
          {items.length > 0 ? (
            <ToastItems items={items} moreCount={data?.moreCount} closeToast={closeToast} />
          ) : null}
          {detail && hasActions ? (
            <div className="flex min-w-0 items-center gap-2" data-slot="toast-detail-row">
              <ToastDetail text={detail} className="flex-1" />
              <ToastActions actions={actions} actionProps={actionProps} closeToast={closeToast} />
            </div>
          ) : (
            <>
              {detail ? <ToastDetail text={detail} /> : null}
              {hasActions ? (
                <ToastActions
                  actions={actions}
                  actionProps={actionProps}
                  closeToast={closeToast}
                  className="justify-end"
                />
              ) : null}
            </>
          )}
        </div>
      ) : null}
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

const TOAST_WHEEL_LEAVE_MS = 180;
const TOAST_WHEEL_LEAVE_REDUCED_MS = 120;
/** How far past its own width a dismissed toast slides. */
const TOAST_WHEEL_LEAVE_OVERSHOOT_PX = 16;

function clearWheelDrag(element: HTMLElement) {
  element.removeAttribute("data-wheel-dragging");
  element.style.translate = "";
  element.style.opacity = "";
}

/**
 * Two-finger horizontal trackpad swipes over a toast drag it toward the screen edge and dismiss
 * it past a threshold, like a macOS notification banner. One listener on the viewport; each
 * gesture locks to the toast it started on, so momentum after a dismissal never reaches the
 * toast that slides into its place.
 *
 * Mouse wheels: line-mode wheels (Firefox) never swipe. Chromium reports mouse wheels in pixels
 * too; the macOS desktop app tells them apart through the main process, but on the web and on
 * Windows a horizontal mouse wheel over a toast can dismiss it as well.
 */
function useToastWheelDismiss(viewport: HTMLElement | null, position: ToastPosition) {
  useEffect(() => {
    if (!viewport) return;
    const outward: ToastWheelOutward = position.includes("center")
      ? "either"
      : position.includes("left")
        ? "left"
        : "right";
    let gesture: {
      state: ToastWheelState;
      element: HTMLElement;
      toastId: string;
      width: number;
    } | null = null;
    let idleTimer: number | undefined;
    // The desktop app reports a mouse-wheel scroll as it begins (sometimes after its first event).
    let mouseWheelScroll = false;

    const endGesture = () => {
      window.clearTimeout(idleTimer);
      idleTimer = undefined;
      const ended = gesture;
      gesture = null;
      // A swipe that stopped short snaps back through the root's translate transition.
      if (ended?.state.kind === "tracking") clearWheelDrag(ended.element);
    };

    const unsubscribeTrackpad = window.desktopBridge?.onTrackpadScroll?.((event) => {
      if (event.phase === "end") {
        mouseWheelScroll = false;
        return;
      }
      mouseWheelScroll = event.precise === false;
      if (mouseWheelScroll && gesture) {
        if (gesture.state.kind === "tracking") clearWheelDrag(gesture.element);
        gesture.state = { kind: "ignored" };
      }
    });

    /**
     * Closes the toast right away, so a repeat is a new toast and nothing is left pending if
     * this effect restarts. Its transform is pinned so the stack's own exit doesn't add a second
     * slide; the inline slide and fade run while Base UI waits for them to unmount it.
     */
    const dismiss = (element: HTMLElement, toastId: string, direction: "left" | "right") => {
      const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
      const duration = reduced ? TOAST_WHEEL_LEAVE_REDUCED_MS : TOAST_WHEEL_LEAVE_MS;
      element.style.transform = getComputedStyle(element).transform;
      element.removeAttribute("data-wheel-dragging");
      element.style.transition = reduced
        ? `opacity ${duration}ms ease-out`
        : `translate ${duration}ms ease-in, opacity ${duration}ms ease-in`;
      if (!reduced) {
        const distance = element.getBoundingClientRect().width + TOAST_WHEEL_LEAVE_OVERSHOOT_PX;
        element.style.translate = `${direction === "right" ? distance : -distance}px 0`;
      }
      element.style.opacity = "0";
      toastManager.close(toastId);
    };

    const onWheel = (event: WheelEvent) => {
      if (mouseWheelScroll) return;
      if (!gesture) {
        const element =
          event.target instanceof Element
            ? event.target.closest<HTMLElement>("[data-toast-id]")
            : null;
        const toastId = element?.dataset.toastId;
        if (!element || !toastId || !viewport.contains(element)) return;
        // Already on its way out (closed elsewhere, or by an earlier swipe).
        if (element.hasAttribute("data-ending-style")) return;
        gesture = {
          state: INITIAL_TOAST_WHEEL_STATE,
          element,
          toastId,
          width: element.getBoundingClientRect().width,
        };
      } else if (
        gesture.state.kind === "tracking" &&
        gesture.element.hasAttribute("data-ending-style")
      ) {
        // Closed mid-drag (timeout or elsewhere): let its exit fade run, and drop the gesture.
        clearWheelDrag(gesture.element);
        gesture.state = { kind: "ignored" };
      }
      window.clearTimeout(idleTimer);
      idleTimer = window.setTimeout(endGesture, TOAST_WHEEL_IDLE_MS);
      const step = stepToastWheel(gesture.state, event, { width: gesture.width, outward });
      gesture.state = step.state;
      if (step.handled) event.preventDefault();
      if (step.dismiss) {
        dismiss(gesture.element, gesture.toastId, step.dismiss);
        return;
      }
      if (step.state.kind !== "tracking") return;
      const { element, width } = gesture;
      element.setAttribute("data-wheel-dragging", "");
      element.style.translate = `${step.offset}px 0`;
      element.style.opacity = String(1 - 0.6 * toastWheelProgress(step.offset, width, outward));
    };

    viewport.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      viewport.removeEventListener("wheel", onWheel);
      unsubscribeTrackpad?.();
      endGesture();
    };
  }, [viewport, position]);
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
  const [viewport, setViewport] = useState<HTMLDivElement | null>(null);
  useToastWheelDismiss(viewport, position);

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
        ref={setViewport}
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
                toastSurfaceClassName,
                "group/toast absolute z-[calc(9999-var(--toast-index))] h-(--toast-calc-height) w-full select-none text-popover-foreground [transition:transform_.5s_cubic-bezier(.22,1,.36,1),opacity_.5s,height_.15s,translate_.2s_ease-out]",
                // A trackpad swipe drags the toast with the fingers: no lag on translate or fade.
                "not-data-ending-style:data-wheel-dragging:[transition:transform_.5s_cubic-bezier(.22,1,.36,1),height_.15s]",
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
                // Important, so a drag's inline opacity can't keep a closing toast visible.
                "data-ending-style:opacity-0!",
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
                // Reduced motion: fade only; a short swipe snaps back without sliding.
                "motion-reduce:[transition:opacity_.2s,height_.15s] motion-reduce:data-starting-style:transform-none motion-reduce:data-ending-style:transform-none",
                "motion-reduce:not-data-ending-style:data-wheel-dragging:[transition:height_.15s]",
              )}
              data-position={position}
              data-toast-id={toast.id}
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
                  "pointer-events-auto relative overflow-hidden rounded-[inherit] py-2.5 pr-3 pl-4 text-ui transition-opacity duration-250 data-expanded:opacity-100",
                  hideCollapsedContent &&
                    "not-data-expanded:pointer-events-none not-data-expanded:opacity-0",
                )}
              >
                <ToastCardBody
                  type={toast.type}
                  data={toast.data}
                  hasDescription={toast.description != null}
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
                      : toastSurfaceClassName,
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
                      <Toast.Content className="pointer-events-auto relative overflow-hidden rounded-[inherit] py-2.5 pr-3 pl-4 text-ui">
                        <ToastCardBody
                          type={toast.type}
                          data={toast.data}
                          hasDescription={toast.description != null}
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
