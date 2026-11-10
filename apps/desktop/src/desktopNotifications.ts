import type {
  DesktopNotificationActivation,
  DesktopNotificationShowInput,
  DesktopNotificationTarget,
} from "@t3tools/contracts";

export const DESKTOP_NOTIFICATION_SHOW_CHANNEL = "desktop:notification-show";
export const DESKTOP_NOTIFICATION_TAKE_ACTIVATIONS_CHANNEL =
  "desktop:take-notification-activations";
export const DESKTOP_NOTIFICATION_ACTIVATIONS_AVAILABLE_CHANNEL =
  "desktop:notification-activations-available";

const MAX_TITLE_LENGTH = 256;
const MAX_BODY_LENGTH = 1024;
const MAX_ID_LENGTH = 256;
/** Only PNG data URLs, which Electron's `nativeImage` decodes; small enough for an icon. */
const MAX_ICON_LENGTH = 64 * 1024;
const ICON_PREFIX = "data:image/png;base64,";
/** Held per profile, so a busy profile cannot evict another profile's notifications. */
const DEFAULT_MAX_ENTRIES = 200;
const MAX_PENDING_PER_PROFILE = 20;
/** A click nobody took by then is dropped instead of replayed on a later focus. */
const DEFAULT_ACTIVATION_TTL_MS = 60_000;

/** The slice of Electron's `Notification` the registry uses. */
export interface DesktopNotificationLike {
  on(event: "click", listener: () => void): unknown;
  show(): void;
  close(): void;
}

export interface DesktopNotificationRegistryOptions {
  create(input: {
    title: string;
    body?: string;
    silent?: boolean;
    icon?: string;
  }): DesktopNotificationLike;
  /**
   * Shows, restores, focuses or creates the profile's window. Resolving `false` means no window
   * was opened (the app is quitting).
   */
  openProfile(profileId: string): Promise<unknown>;
  /** The webContents id of the window `openProfile` brought forward, if any. */
  selectWindow(profileId: string): number | null;
  /** Tells that window, or every window of the profile when null, that activations wait. */
  announce(profileId: string, webContentsId: number | null): void;
  log?(message: string): void;
  maxEntries?: number;
  activationTtlMs?: number;
  now?(): number;
}

type Entry = {
  readonly profileId: string;
  readonly id: string;
  readonly target: DesktopNotificationTarget;
  readonly notice: DesktopNotificationLike;
};

type PendingActivation = DesktopNotificationActivation & {
  /** Only this window takes it, so a background window cannot navigate in its place. */
  readonly webContentsId: number | null;
  readonly expiresAt: number;
};

function boundedString(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  return trimmed.length > max ? trimmed.slice(0, max) : trimmed;
}

function exactId(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_ID_LENGTH
    ? value
    : null;
}

export function parseDesktopNotificationTarget(raw: unknown): DesktopNotificationTarget | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Record<string, unknown>;
  switch (value.kind) {
    case "thread": {
      const threadId = exactId(value.threadId);
      return threadId ? { kind: "thread", threadId } : null;
    }
    case "prHub": {
      if (value.prKey === undefined) return { kind: "prHub" };
      const prKey = exactId(value.prKey);
      return prKey ? { kind: "prHub", prKey } : null;
    }
    case "scheduled": {
      const taskId = exactId(value.taskId);
      return taskId ? { kind: "scheduled", taskId } : null;
    }
    case "upstream": {
      const projectId = exactId(value.projectId);
      return projectId ? { kind: "upstream", projectId } : null;
    }
    case "update":
      return { kind: "update" };
    case "none":
      return { kind: "none" };
    default:
      return null;
  }
}

/** Validates renderer input; titles and bodies are capped rather than rejected. */
export function parseDesktopNotificationInput(raw: unknown): DesktopNotificationShowInput | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Record<string, unknown>;
  const id = exactId(value.id);
  const title = boundedString(value.title, MAX_TITLE_LENGTH);
  const target = parseDesktopNotificationTarget(value.target);
  if (!id || !title || !target) return null;
  const body = value.body === undefined ? null : boundedString(value.body, MAX_BODY_LENGTH);
  const tag = value.tag === undefined ? null : exactId(value.tag);
  if (value.tag !== undefined && !tag) return null;
  // An icon that isn't a small PNG is dropped rather than failing the notification.
  const icon =
    typeof value.icon === "string" &&
    value.icon.startsWith(ICON_PREFIX) &&
    value.icon.length <= MAX_ICON_LENGTH
      ? value.icon
      : null;
  return {
    id,
    title,
    target,
    ...(body ? { body } : {}),
    ...(tag ? { tag } : {}),
    ...(value.silent === true ? { silent: true } : {}),
    ...(icon ? { icon } : {}),
  };
}

/**
 * Holds every shown notification until it is clicked, closed on purpose or evicted. macOS may
 * report a banner as closed when it moves to Notification Center, and a collected object loses
 * its click handler, so the `close` event never releases an entry.
 */
export class DesktopNotificationRegistry {
  private readonly entries = new Map<string, Entry>();
  private readonly pending = new Map<string, PendingActivation[]>();
  private readonly maxEntries: number;
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(private readonly options: DesktopNotificationRegistryOptions) {
    this.maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
    this.ttlMs = options.activationTtlMs ?? DEFAULT_ACTIVATION_TTL_MS;
    this.now = options.now ?? Date.now;
  }

  get size(): number {
    return this.entries.size;
  }

  show(profileId: string, input: DesktopNotificationShowInput): boolean {
    const key = this.key(profileId, input.tag ?? `id:${input.id}`);
    const previous = this.entries.get(key);
    if (previous) {
      this.entries.delete(key);
      this.safeClose(previous.notice);
    }
    let notice: DesktopNotificationLike;
    try {
      notice = this.options.create({
        title: input.title,
        ...(input.body ? { body: input.body } : {}),
        ...(input.silent ? { silent: true } : {}),
        ...(input.icon ? { icon: input.icon } : {}),
      });
    } catch (error) {
      this.options.log?.(`notification create failed: ${String(error)}`);
      return false;
    }
    const entry: Entry = { profileId, id: input.id, target: input.target, notice };
    notice.on("click", () => this.activate(key, entry));
    this.entries.set(key, entry);
    this.evictOldest(profileId);
    try {
      notice.show();
    } catch (error) {
      this.entries.delete(key);
      this.options.log?.(`notification show failed: ${String(error)}`);
      return false;
    }
    return true;
  }

  /**
   * Takes the unexpired activations meant for this window, oldest first. Activations bound to
   * another window of the profile stay queued for it.
   */
  take(profileId: string, webContentsId: number): DesktopNotificationActivation[] {
    const now = this.now();
    const queued = (this.pending.get(profileId) ?? []).filter((item) => item.expiresAt > now);
    const taken: DesktopNotificationActivation[] = [];
    const kept: PendingActivation[] = [];
    for (const item of queued) {
      if (item.webContentsId === null || item.webContentsId === webContentsId)
        taken.push({ id: item.id, target: item.target });
      else kept.push(item);
    }
    if (kept.length > 0) this.pending.set(profileId, kept);
    else this.pending.delete(profileId);
    return taken;
  }

  private activate(key: string, entry: Entry): void {
    if (this.entries.get(key) === entry) this.entries.delete(key);
    // Queued only once a window is open, and bound to it. A window that `openProfile` created
    // takes it when its renderer starts; nothing is queued when opening fails.
    void this.options
      .openProfile(entry.profileId)
      .then((opened) => {
        if (opened === false) return;
        const webContentsId = this.options.selectWindow(entry.profileId);
        const queue = this.pending.get(entry.profileId) ?? [];
        queue.push({
          id: entry.id,
          target: entry.target,
          webContentsId,
          expiresAt: this.now() + this.ttlMs,
        });
        if (queue.length > MAX_PENDING_PER_PROFILE)
          queue.splice(0, queue.length - MAX_PENDING_PER_PROFILE);
        this.pending.set(entry.profileId, queue);
        this.options.announce(entry.profileId, webContentsId);
      })
      .catch((error: unknown) => {
        this.options.log?.(`notification activation failed: ${String(error)}`);
      });
  }

  /** Evicted entries stay on screen; only their click falls back to activating the app. */
  private evictOldest(profileId: string): void {
    let count = 0;
    for (const entry of this.entries.values()) if (entry.profileId === profileId) count += 1;
    for (const [key, entry] of this.entries) {
      if (count <= this.maxEntries) break;
      if (entry.profileId !== profileId) continue;
      this.entries.delete(key);
      count -= 1;
    }
  }

  private safeClose(notice: DesktopNotificationLike): void {
    try {
      notice.close();
    } catch {
      // A notification the OS already removed cannot be closed again.
    }
  }

  private key(profileId: string, tag: string): string {
    return `${profileId}\u0000${tag}`;
  }
}
