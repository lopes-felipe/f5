import type { PreviewAutomationRequest, PreviewAutomationResponse } from "@t3tools/contracts";

interface CachedPreviewAutomationResponse {
  readonly payloadKey: string;
  readonly response: PreviewAutomationResponse;
  readonly expiresAt: number;
}

export type PreviewAutomationResponseCacheLookup =
  | { readonly kind: "miss" }
  | { readonly kind: "hit"; readonly response: PreviewAutomationResponse }
  | { readonly kind: "mismatch" };

function requestPayloadKey(request: PreviewAutomationRequest): string {
  return JSON.stringify({
    clientId: request.clientId ?? null,
    connectionId: request.connectionId ?? null,
    threadId: request.threadId,
    tabId: request.tabId ?? null,
    operation: request.operation,
    input: request.input,
    timeoutMs: request.timeoutMs,
  });
}

export class PreviewAutomationResponseCache {
  readonly #entries = new Map<string, CachedPreviewAutomationResponse>();

  constructor(
    readonly maximumEntries = 256,
    readonly retentionMs = 5 * 60_000,
  ) {}

  get size(): number {
    return this.#entries.size;
  }

  lookup(
    request: PreviewAutomationRequest,
    now = Date.now(),
  ): PreviewAutomationResponseCacheLookup {
    this.#prune(now);
    const cached = this.#entries.get(request.requestId);
    if (!cached) return { kind: "miss" };
    if (cached.payloadKey !== requestPayloadKey(request)) return { kind: "mismatch" };
    return { kind: "hit", response: cached.response };
  }

  store(
    request: PreviewAutomationRequest,
    response: PreviewAutomationResponse,
    now = Date.now(),
  ): void {
    this.#prune(now);
    this.#entries.set(request.requestId, {
      payloadKey: requestPayloadKey(request),
      response,
      expiresAt: now + this.retentionMs,
    });
    while (this.#entries.size > this.maximumEntries) {
      const oldestRequestId = this.#entries.keys().next().value;
      if (oldestRequestId === undefined) break;
      this.#entries.delete(oldestRequestId);
    }
  }

  clear(): void {
    this.#entries.clear();
  }

  #prune(now: number): void {
    for (const [requestId, entry] of this.#entries) {
      if (entry.expiresAt <= now) this.#entries.delete(requestId);
    }
  }
}
