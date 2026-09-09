import { stripVTControlCharacters } from "node:util";
import type { DiscoveredLocalServer } from "@t3tools/contracts";
import { LSOF_LOCAL_HOST_TOKENS } from "@t3tools/shared/preview";

export const COMMON_DEV_PORTS: ReadonlyArray<number> = Object.freeze([
  3000, 3001, 3333, 4173, 4200, 4321, 5000, 5173, 5174, 5175, 5500, 8000, 8080, 8081, 8888, 9000,
]);

export const PREVIEW_READINESS_PROBE_TIMEOUT_MS = 750;
export const PREVIEW_READINESS_PROBE_CONCURRENCY = 8;

type ReadinessFetch = (
  input: string,
  init: { readonly signal: AbortSignal; readonly redirect: "manual" },
) => Promise<{ readonly status?: number; readonly body?: { cancel: () => Promise<void> } | null }>;

function serverForPort(input: {
  readonly port: number;
  readonly processName?: string | null;
  readonly pid?: number | null;
}): DiscoveredLocalServer {
  return {
    host: "localhost",
    port: input.port,
    url: `http://localhost:${input.port}`,
    processName: input.processName ?? null,
    pid: input.pid ?? null,
  };
}

export function parsePortFromLsofName(name: string): number | null {
  const trimmed = name.split(" ", 1)[0]?.trim() ?? "";
  if (trimmed.length === 0) return null;
  const lastColon = trimmed.lastIndexOf(":");
  if (lastColon < 0) return null;
  const hostPart = trimmed.slice(0, lastColon);
  const portPart = trimmed.slice(lastColon + 1);
  if (!LSOF_LOCAL_HOST_TOKENS.has(hostPart)) return null;
  const port = Number.parseInt(portPart, 10);
  if (!Number.isFinite(port) || port <= 0 || port >= 65536) return null;
  return port;
}

export function parseLsofOutput(raw: string): ReadonlyArray<DiscoveredLocalServer> {
  const seen = new Map<string, DiscoveredLocalServer>();
  let pid: number | null = null;
  let processName: string | null = null;

  for (const line of raw.split("\n")) {
    if (line.length === 0) continue;
    const tag = line.charAt(0);
    const value = line.slice(1);
    if (tag === "p") {
      const parsed = Number.parseInt(value, 10);
      pid = Number.isFinite(parsed) && parsed > 0 ? parsed : null;
      processName = null;
      continue;
    }
    if (tag === "c") {
      processName = value.trim() || null;
      continue;
    }
    if (tag === "n") {
      const port = parsePortFromLsofName(value);
      if (port === null) continue;
      const key = `localhost:${port}`;
      if (!seen.has(key)) {
        seen.set(key, serverForPort({ port, processName, pid }));
      }
    }
  }

  return [...seen.values()].toSorted((left, right) => left.port - right.port);
}

export function parseWindowsListenerOutput(raw: string): ReadonlyArray<DiscoveredLocalServer> {
  const seen = new Map<number, DiscoveredLocalServer>();
  for (const line of raw.split(/\r?\n/g)) {
    const [hostRaw, portRaw, pidRaw, processNameRaw] = line.trim().split("|", 4);
    const host = hostRaw?.trim() ?? "";
    if (!LSOF_LOCAL_HOST_TOKENS.has(host) && host !== "::") continue;
    const port = Number(portRaw);
    const pid = Number(pidRaw);
    if (!Number.isInteger(port) || port <= 0 || port >= 65536) continue;
    if (seen.has(port)) continue;
    seen.set(
      port,
      serverForPort({
        port,
        processName: processNameRaw?.trim() || null,
        pid: Number.isInteger(pid) && pid > 0 ? pid : null,
      }),
    );
  }
  return [...seen.values()].toSorted((left, right) => left.port - right.port);
}

async function isReadyLocalServer(
  server: DiscoveredLocalServer,
  fetchImplementation: ReadinessFetch,
  timeoutMs: number,
): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  try {
    const response = await fetchImplementation(server.url, {
      signal: controller.signal,
      redirect: "manual",
    });
    await response.body?.cancel().catch(() => undefined);
    return (response.status ?? 200) >= 200 && (response.status ?? 200) < 500;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

export async function filterReadyLocalServers(
  servers: ReadonlyArray<DiscoveredLocalServer>,
  options: {
    readonly fetchImplementation?: ReadinessFetch;
    readonly timeoutMs?: number;
    readonly concurrency?: number;
  } = {},
): Promise<ReadonlyArray<DiscoveredLocalServer>> {
  if (servers.length === 0) return [];
  const fetchImplementation = options.fetchImplementation ?? fetch;
  const timeoutMs = options.timeoutMs ?? PREVIEW_READINESS_PROBE_TIMEOUT_MS;
  const concurrency = Math.max(
    1,
    Math.min(options.concurrency ?? PREVIEW_READINESS_PROBE_CONCURRENCY, servers.length),
  );
  const ready = Array.from({ length: servers.length }, () => false);
  let nextIndex = 0;
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      while (nextIndex < servers.length) {
        const index = nextIndex;
        nextIndex += 1;
        const server = servers[index];
        if (server) {
          ready[index] = await isReadyLocalServer(server, fetchImplementation, timeoutMs);
        }
      }
    }),
  );
  return servers.filter((_server, index) => ready[index]);
}

/** Only inspect URLs emitted by processes owned by this profile. */
export async function scanLocalServers(
  ownedUrls: Iterable<string> = [],
): Promise<ReadonlyArray<DiscoveredLocalServer>> {
  const candidates = new Map<string, DiscoveredLocalServer>();
  for (const value of ownedUrls) {
    try {
      const url = new URL(value);
      if (
        !["http:", "https:"].includes(url.protocol) ||
        !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
      )
        continue;
      candidates.set(url.origin, {
        host: url.hostname,
        port: Number(url.port || (url.protocol === "https:" ? 443 : 80)),
        url: url.origin,
        processName: null,
        pid: null,
      });
    } catch {
      /* Incomplete output URL. */
    }
  }
  return filterReadyLocalServers([...candidates.values()]);
}

export class OwnedPreviewUrls {
  readonly urls = new Set<string>();
  private readonly tails = new Map<string, string>();
  append(owner: string, output: string): void {
    const text = stripVTControlCharacters((this.tails.get(owner) ?? "") + output);
    this.tails.set(owner, text.slice(-2048));
    if (this.tails.size > 128) this.tails.delete(this.tails.keys().next().value!);
    for (const match of text.matchAll(
      /https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::[0-9]{1,5})?(?=[/\s])/g,
    )) {
      this.urls.add(match[0]);
      if (this.urls.size > 256) this.urls.delete(this.urls.values().next().value!);
    }
  }
}
