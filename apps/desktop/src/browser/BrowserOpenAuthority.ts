import { randomUUID } from "node:crypto";
import type { OpenExternalUrlStatus } from "@t3tools/contracts";
import { getSafeBrowserLoginUrl } from "./externalUrl";

export interface BrowserOpenPrompt {
  requestId: string;
  profileId: string;
  host: string;
  url: string;
  /** When the request is denied, counting from when it was made, not shown. */
  expiresAtMs: number;
  /** Requests queued behind this one. */
  waiting: number;
  signal: AbortSignal;
}
interface Request {
  id: string;
  expiresAtMs: number;
  url: string;
  host: string;
  controller: AbortController;
  resolve: (status: OpenExternalUrlStatus) => void;
  timer: ReturnType<typeof setTimeout>;
  settled: boolean;
}
interface ProfileQueue {
  active?: Request;
  waiting: Request[];
}

const BROWSER_OPEN_TIMEOUT_MS = 5 * 60 * 1000;

/** Session-only consent. No renderer or sandboxed process can write these grants. */
export class BrowserOpenAuthority {
  private readonly allowed = new Map<string, Set<string>>();
  private readonly queues = new Map<string, ProfileQueue>();
  private readonly recentOpens = new Map<string, number[]>();
  constructor(
    private readonly effects: {
      prompt: (request: BrowserOpenPrompt) => Promise<number>;
      open: (url: string) => Promise<unknown>;
      copy: (url: string) => void;
      /** A request queued behind the active prompt while it was shown. */
      waitingChanged?: (profileId: string, waiting: number) => void;
    },
  ) {}

  /** Validate before consent; remembered hosts still share a per-profile browser-open budget. */
  request(profileId: string, rawUrl: unknown): Promise<OpenExternalUrlStatus> {
    const url = getSafeBrowserLoginUrl(rawUrl);
    if (!url) return Promise.resolve("invalid");
    const host = new URL(url).hostname.toLowerCase();
    if (this.allowed.get(profileId)?.has(host))
      return Promise.resolve()
        .then(() => this.open(profileId, url))
        .catch(() => "denied" as const);
    const queue = this.queues.get(profileId) ?? { waiting: [] };
    if (queue.active && queue.waiting.length >= 3) return Promise.resolve("busy");
    this.queues.set(profileId, queue);
    return new Promise((resolve) => {
      const request: Request = {
        id: randomUUID(),
        expiresAtMs: Date.now() + BROWSER_OPEN_TIMEOUT_MS,
        url,
        host,
        resolve,
        controller: new AbortController(),
        settled: false,
        // Include queue time so every launcher gets an answer within its six-minute wait.
        timer: setTimeout(() => {
          this.finish(request, "denied");
          queue.waiting = queue.waiting.filter((entry) => entry !== request);
        }, BROWSER_OPEN_TIMEOUT_MS),
      };
      queue.waiting.push(request);
      this.drain(profileId, queue);
      // Queued requests are younger than the active one, so they never expire while it shows.
      if (queue.active !== request) this.reportWaiting(profileId, queue);
    });
  }

  /** Revoke pending dialogs on disconnect without forgetting session host approvals. */
  cancelProfile(profileId: string): void {
    const queue = this.queues.get(profileId);
    if (!queue) return;
    if (queue.active) this.finish(queue.active, "denied");
    for (const request of queue.waiting) this.finish(request, "denied");
    queue.waiting = [];
    // Keep the active slot until the aborted native dialog has actually closed.
    if (!queue.active) this.queues.delete(profileId);
  }

  private waitingCount(queue: ProfileQueue): number {
    return queue.waiting.filter((entry) => !entry.settled).length;
  }

  private reportWaiting(profileId: string, queue: ProfileQueue): void {
    if (queue.active && !queue.active.settled)
      this.effects.waitingChanged?.(profileId, this.waitingCount(queue));
  }

  private finish(request: Request, status: OpenExternalUrlStatus): void {
    if (request.settled) return;
    request.settled = true;
    clearTimeout(request.timer);
    request.controller.abort();
    request.resolve(status);
  }

  private drain(profileId: string, queue: ProfileQueue): void {
    if (queue.active) return;
    const request = queue.waiting.shift();
    if (!request) {
      this.queues.delete(profileId);
      return;
    }
    if (request.settled) {
      this.drain(profileId, queue);
      return;
    }
    queue.active = request;
    void this.perform(profileId, request, this.waitingCount(queue))
      .then(
        (status) => this.finish(request, status),
        () => this.finish(request, "denied"),
      )
      .finally(() => {
        delete queue.active;
        this.drain(profileId, queue);
      });
  }

  private async perform(
    profileId: string,
    request: Request,
    waiting: number,
  ): Promise<OpenExternalUrlStatus> {
    if (!this.allowed.get(profileId)?.has(request.host)) {
      const button = await this.effects.prompt({
        requestId: request.id,
        profileId,
        host: request.host,
        url: request.url,
        expiresAtMs: request.expiresAtMs,
        waiting,
        signal: request.controller.signal,
      });
      // A timeout or backend restart cannot approve a late answer.
      if (request.settled) return "denied";
      if (button === 2) {
        this.effects.copy(request.url);
        return "copied";
      }
      if (button !== 0 && button !== 1) return "denied";
      if (button === 1) {
        const hosts = this.allowed.get(profileId) ?? new Set<string>();
        hosts.add(request.host);
        this.allowed.set(profileId, hosts);
      }
    }
    if (request.settled) return "denied";
    return this.open(profileId, request.url);
  }

  /** At most ten browser launches per rolling minute, including concurrent requests. */
  private async open(profileId: string, url: string): Promise<OpenExternalUrlStatus> {
    const now = Date.now();
    const recent = (this.recentOpens.get(profileId) ?? []).filter((time) => now - time < 60_000);
    this.recentOpens.set(profileId, recent);
    if (recent.length >= 10) return "busy";
    recent.push(now);
    await this.effects.open(url);
    return "opened";
  }
}
