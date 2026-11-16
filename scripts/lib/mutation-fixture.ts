import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

/**
 * Loopback fixture for live certification runs. Every page load (`GET /marker/:id`) and
 * button press (`POST /mutate/:id`) is recorded with its time, so a harness can prove that
 * work stopped instead of trusting a tool result. Pages carry their marker in the title
 * and body, so a tool result naming another session's marker is detectable.
 */
export interface MutationServer {
  readonly origin: string;
  /** Times of every load and mutation for `marker`, in order. */
  readonly hits: (marker: string) => ReadonlyArray<number>;
  readonly mutations: (marker: string) => ReadonlyArray<number>;
  readonly close: () => Promise<void>;
}

const MARKER = /^[A-Za-z0-9_-]{1,64}$/;
export const markerTitle = (marker: string) => `F5 marker ${marker}`;

export function markerPage(marker: string): string {
  const title = markerTitle(marker);
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>${title}</title></head>
<body><h1>${title}</h1>
<button id="mutate" onclick="fetch('/mutate/${marker}', { method: 'POST' })">Mutate ${marker}</button>
</body></html>`;
}

export async function startMutationServer(now: () => number = Date.now): Promise<MutationServer> {
  const loads = new Map<string, number[]>();
  const mutations = new Map<string, number[]>();
  const record = (map: Map<string, number[]>, marker: string) => {
    const list = map.get(marker) ?? [];
    list.push(now());
    map.set(marker, list);
  };
  const server = createServer((request, response) => {
    const [, kind, marker = ""] = (request.url ?? "").split("?")[0]!.split("/");
    if (!MARKER.test(marker)) {
      response.writeHead(404).end();
      return;
    }
    if (kind === "marker" && request.method === "GET") {
      record(loads, marker);
      response
        .writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" })
        .end(markerPage(marker));
      return;
    }
    if (kind === "mutate" && request.method === "POST") {
      record(mutations, marker);
      request.resume();
      response.writeHead(204).end();
      return;
    }
    response.writeHead(404).end();
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const { port } = server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${port}`,
    hits: (marker) =>
      [...(loads.get(marker) ?? []), ...(mutations.get(marker) ?? [])].sort((a, b) => a - b),
    mutations: (marker) => [...(mutations.get(marker) ?? [])],
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

export interface QuietWindow {
  /** Work running before the stop: the positive control. */
  readonly minHitsBefore: number;
  /** In-flight work may still land this long after the stop. */
  readonly settleMs: number;
  /** Then nothing may land for this long. */
  readonly quietMs: number;
}
export const DEFAULT_QUIET_WINDOW: QuietWindow = {
  minHitsBefore: 3,
  settleMs: 2000,
  quietMs: 5000,
};

/**
 * Whether work that was observably running stopped after `stoppedAt`: enough hits before
 * it, none after the settle window, and an observation that lasted the whole quiet window.
 */
export function stoppedAfter(
  hits: ReadonlyArray<number>,
  stoppedAt: number,
  observedUntil: number,
  window: QuietWindow = DEFAULT_QUIET_WINDOW,
): boolean {
  const quietFrom = stoppedAt + window.settleMs;
  return (
    hits.filter((time) => time <= stoppedAt).length >= window.minHitsBefore &&
    observedUntil >= quietFrom + window.quietMs &&
    hits.every((time) => time <= quietFrom)
  );
}
