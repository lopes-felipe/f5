import type {
  DesktopNotificationActivation,
  DesktopNotificationShowInput,
  DesktopNotificationTarget,
} from "@t3tools/contracts";

export const DESKTOP_NOTIFICATION_SHOW_CHANNEL = "desktop:notification-show";
export const DESKTOP_NOTIFICATION_CLOSE_CHANNEL = "desktop:notification-close";
export const DESKTOP_NOTIFICATION_TAKE_ACTIVATIONS_CHANNEL =
  "desktop:take-notification-activations";
export const DESKTOP_NOTIFICATION_ACTIVATIONS_AVAILABLE_CHANNEL =
  "desktop:notification-activations-available";

const MAX_TITLE_LENGTH = 256;
const MAX_BODY_LENGTH = 1024;
const MAX_ID_LENGTH = 256;
const DEFAULT_MAX_ENTRIES = 200;
const MAX_PENDING_PER_PROFILE = 20;

/** The slice of Electron's `Notification` the registry uses. */
export interface DesktopNotificationLike {
  on(event: "click", listener: () => void): unknown;
  show(): void;
  close(): void;
}

export interface DesktopNotificationRegistryOptions {
  create(input: { title: string; body?: string; silent?: boolean }): DesktopNotificationLike;
  /** Shows, restores, focuses or creates the profile's window. */
  openProfile(profileId: string): Promise<unknown>;
  /** Tells the profile's renderer that activations are waiting. */
  announce(profileId: string): void;
  log?(message: string): void;
  maxEntries?: number;
}

type Entry = {
  readonly profileId: string;
  readonly id: string;
  readonly target: DesktopNotificationTarget;
  readonly notice: DesktopNotificationLike;
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
  return {
    id,
    title,
    target,
    ...(body ? { body } : {}),
    ...(tag ? { tag } : {}),
    ...(value.silent === true ? { silent: true } : {}),
  };
}

/**
 * Holds every shown notification until it is clicked, closed on purpose or evicted. macOS may
 * report a banner as closed when it moves to Notification Center, and a collected object loses
 * its click handler, so the `close` event never releases an entry.
 */
export class DesktopNotificationRegistry {
  private readonly entries = new Map<string, Entry>();
  private readonly pending = new Map<string, DesktopNotificationActivation[]>();
  private readonly maxEntries: number;

  constructor(private readonly options: DesktopNotificationRegistryOptions) {
    this.maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
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
      });
    } catch (error) {
      this.options.log?.(`notification create failed: ${String(error)}`);
      return false;
    }
    const entry: Entry = { profileId, id: input.id, target: input.target, notice };
    notice.on("click", () => this.activate(key, entry));
    this.entries.set(key, entry);
    while (this.entries.size > this.maxEntries) {
      // Evicted entries stay on screen; only their click falls back to activating the app.
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
    try {
      notice.show();
    } catch (error) {
      this.entries.delete(key);
      this.options.log?.(`notification show failed: ${String(error)}`);
      return false;
    }
    return true;
  }

  close(profileId: string, tag: string): void {
    const key = this.key(profileId, tag);
    const entry = this.entries.get(key);
    if (!entry) return;
    this.entries.delete(key);
    this.safeClose(entry.notice);
  }

  take(profileId: string): DesktopNotificationActivation[] {
    const queued = this.pending.get(profileId) ?? [];
    this.pending.delete(profileId);
    return queued;
  }

  private activate(key: string, entry: Entry): void {
    if (this.entries.get(key) === entry) this.entries.delete(key);
    const queue = this.pending.get(entry.profileId) ?? [];
    queue.push({ id: entry.id, target: entry.target });
    if (queue.length > MAX_PENDING_PER_PROFILE)
      queue.splice(0, queue.length - MAX_PENDING_PER_PROFILE);
    this.pending.set(entry.profileId, queue);
    // Queue first: a window created by `openProfile` drains the queue as soon as it loads.
    void this.options
      .openProfile(entry.profileId)
      .then(() => this.options.announce(entry.profileId))
      .catch((error: unknown) => {
        this.options.log?.(`notification activation failed: ${String(error)}`);
      });
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
