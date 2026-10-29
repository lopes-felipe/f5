import type { OpenExternalUrlStatus } from "@t3tools/contracts";
import { getSafeBrowserLoginUrl } from "./externalUrl";

interface BrowserOpenPrompt {
  profileId: string;
  host: string;
  url: string;
  signal: AbortSignal;
}
interface Request {
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

/** Session-only consent. No renderer or sandboxed process can write these grants. */
export class BrowserOpenAuthority {
  private readonly allowed = new Map<string, Set<string>>();
  private readonly queues = new Map<string, ProfileQueue>();
  constructor(
    private readonly effects: {
      prompt: (request: BrowserOpenPrompt) => Promise<number>;
      open: (url: string) => Promise<unknown>;
      copy: (url: string) => void;
    },
  ) {}

  request(profileId: string, rawUrl: unknown): Promise<OpenExternalUrlStatus> {
    const url = getSafeBrowserLoginUrl(rawUrl);
    if (!url) return Promise.resolve("invalid");
    const host = new URL(url).hostname.toLowerCase();
    if (this.allowed.get(profileId)?.has(host))
      return Promise.resolve()
        .then(() => this.effects.open(url))
        .then(
          () => "opened" as const,
          () => "denied" as const,
        );
    const queue = this.queues.get(profileId) ?? { waiting: [] };
    if (queue.active && queue.waiting.length >= 3) return Promise.resolve("busy");
    this.queues.set(profileId, queue);
    return new Promise((resolve) => {
      const request: Request = {
        url,
        host,
        resolve,
        controller: new AbortController(),
        settled: false,
        // Include queue time so every launcher gets an answer within its six-minute wait.
        timer: setTimeout(
          () => {
            this.finish(request, "denied");
            queue.waiting = queue.waiting.filter((entry) => entry !== request);
          },
          5 * 60 * 1000,
        ),
      };
      queue.waiting.push(request);
      this.drain(profileId, queue);
    });
  }

  cancelProfile(profileId: string): void {
    const queue = this.queues.get(profileId);
    if (!queue) return;
    if (queue.active) this.finish(queue.active, "denied");
    for (const request of queue.waiting) this.finish(request, "denied");
    queue.waiting = [];
    // Keep the active slot until the aborted native dialog has actually closed.
    if (!queue.active) this.queues.delete(profileId);
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
    void this.perform(profileId, request)
      .then(
        (status) => this.finish(request, status),
        () => this.finish(request, "denied"),
      )
      .finally(() => {
        delete queue.active;
        this.drain(profileId, queue);
      });
  }

  private async perform(profileId: string, request: Request): Promise<OpenExternalUrlStatus> {
    if (!this.allowed.get(profileId)?.has(request.host)) {
      const button = await this.effects.prompt({
        profileId,
        host: request.host,
        url: request.url,
        signal: request.controller.signal,
      });
      // A timeout or backend restart cannot approve a late native dialog result.
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
    await this.effects.open(request.url);
    return "opened";
  }
}
