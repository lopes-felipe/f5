import { execFile } from "node:child_process";
import net from "node:net";
import { promisify } from "node:util";

import type { DiscoveredLocalServer } from "@t3tools/contracts";
import { LSOF_LOCAL_HOST_TOKENS } from "@t3tools/shared/preview";

const execFileAsync = promisify(execFile);

export const COMMON_DEV_PORTS: ReadonlyArray<number> = Object.freeze([
  3000, 3001, 3333, 4173, 4200, 4321, 5000, 5173, 5174, 5175, 5500, 8000, 8080, 8081, 8888, 9000,
]);

const LSOF_TIMEOUT_MS = 5_000;
const WINDOWS_LISTENER_TIMEOUT_MS = 5_000;
export const PREVIEW_READINESS_PROBE_TIMEOUT_MS = 750;
export const PREVIEW_READINESS_PROBE_CONCURRENCY = 8;

type ReadinessFetch = (
  input: string,
  init: { readonly signal: AbortSignal; readonly redirect: "manual" },
) => Promise<{ readonly body?: { cancel: () => Promise<void> } | null }>;

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

function canListenOnHost(port: number, host: string): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    let settled = false;
    const settle = (available: boolean) => {
      if (settled) return;
      settled = true;
      try {
        server.close();
      } catch {
        // Ignore close failures during cleanup.
      }
      resolve(available);
    };
    server.unref();
    server.once("error", (cause) => {
      const code =
        typeof cause === "object" && cause !== null ? (cause as { code?: string }).code : null;
      settle(code === "EADDRNOTAVAIL");
    });
    server.once("listening", () => settle(true));
    server.listen({ host, port });
  });
}

async function isPortAvailableOnLoopback(port: number): Promise<boolean> {
  const [ipv4, ipv6] = await Promise.all([
    canListenOnHost(port, "127.0.0.1"),
    canListenOnHost(port, "::1"),
  ]);
  return ipv4 && ipv6;
}

async function probeCommonPorts(): Promise<ReadonlyArray<DiscoveredLocalServer>> {
  const results = await Promise.all(
    COMMON_DEV_PORTS.map(async (port) => ({
      port,
      listening: !(await isPortAvailableOnLoopback(port)),
    })),
  );
  return results
    .filter((result) => result.listening)
    .map((result) => serverForPort({ port: result.port }));
}

async function scanWithLsof(): Promise<ReadonlyArray<DiscoveredLocalServer> | null> {
  try {
    const result = await execFileAsync("lsof", ["-iTCP", "-sTCP:LISTEN", "-P", "-n", "-F", "pcn"], {
      timeout: LSOF_TIMEOUT_MS,
      maxBuffer: 1024 * 1024,
    });
    return parseLsofOutput(result.stdout);
  } catch {
    return null;
  }
}

async function scanWithPowerShell(): Promise<ReadonlyArray<DiscoveredLocalServer> | null> {
  try {
    const command =
      'Get-NetTCPConnection -State Listen -ErrorAction Stop | ForEach-Object { $processName = (Get-Process -Id $_.OwningProcess -ErrorAction SilentlyContinue).ProcessName; Write-Output "$($_.LocalAddress)|$($_.LocalPort)|$($_.OwningProcess)|$processName" }';
    const result = await execFileAsync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", command],
      {
        timeout: WINDOWS_LISTENER_TIMEOUT_MS,
        maxBuffer: 1024 * 1024,
      },
    );
    return parseWindowsListenerOutput(result.stdout);
  } catch {
    return null;
  }
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
    return true;
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

export async function scanLocalServers(): Promise<ReadonlyArray<DiscoveredLocalServer>> {
  const platformResult =
    process.platform === "win32" ? await scanWithPowerShell() : await scanWithLsof();
  const candidates = platformResult ?? (await probeCommonPorts());
  return filterReadyLocalServers(candidates);
}
