import {
  MOBILE_API_VERSION,
  MOBILE_CLOSE,
  MOBILE_ROOT,
  type MobileBootstrap,
  MobilePairResponse,
  MobileStatus,
  type mobileMethods,
} from "@t3tools/contracts/mobile/v1";
import { Schema } from "effect";
import type { PairedServer, PairingAddress } from "./pairing";
import { decodeMobileBootstrap as decodeBootstrap } from "./decode";

type Method = keyof typeof mobileMethods;
type Body<M extends Method> = (typeof mobileMethods)[M]["Type"];
const decodeStatus = Schema.decodeUnknownSync(MobileStatus);
const decodePair = Schema.decodeUnknownSync(MobilePairResponse);
const DEADLINE = 15_000;
export type LinkState =
  | "connecting"
  | "syncing"
  | "ready"
  | "offline"
  | "revoked"
  | "access-off"
  | "update-required"
  | "rate-limited"
  | "identity-changed";

export class MobileConnectionError extends Error {
  constructor(
    readonly state: LinkState,
    readonly retryAt = 0,
  ) {
    super(state);
  }
}
export class MobileRpcError extends Error {
  constructor(
    readonly code: string,
    readonly retryAfterMs?: number,
  ) {
    super(code);
  }
}

async function http(
  origin: string,
  path: string,
  options: { token?: string; body?: unknown; signal?: AbortSignal } = {},
) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  options.signal?.addEventListener("abort", abort);
  if (options.signal?.aborted) controller.abort();
  const timeout = setTimeout(abort, DEADLINE);
  try {
    const response = await fetch(origin + MOBILE_ROOT + path, {
      redirect: "error",
      signal: controller.signal,
      method: options.body === undefined ? "GET" : "POST",
      headers: {
        ...(options.token ? { Authorization: "Bearer " + options.token } : {}),
        ...(options.body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    });
    if (response.status === 429) {
      const seconds = Number(response.headers.get("Retry-After") ?? "60");
      throw new MobileConnectionError(
        "rate-limited",
        Date.now() + (Number.isFinite(seconds) ? Math.max(1, seconds) : 60) * 1000,
      );
    }
    if (response.status === 401 && options.token) throw new MobileConnectionError("revoked");
    if (response.status === 503) {
      const body = (await response.json().catch(() => null)) as { error?: string } | null;
      if (body?.error === "starting") throw new MobileRpcError("starting");
      if (body?.error === "disabled") throw new MobileConnectionError("access-off");
    }
    if (!response.ok) throw new MobileRpcError("http-" + response.status);
    return (await response.json()) as unknown;
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener("abort", abort);
  }
}

function checkVersion(status: typeof MobileStatus.Type) {
  if (MOBILE_API_VERSION < status.mobileApi.min || MOBILE_API_VERSION > status.mobileApi.current)
    throw new MobileConnectionError("update-required");
}

async function findOrigin(origins: readonly string[], expectedId?: string, signal?: AbortSignal) {
  let failed: unknown = new MobileConnectionError("offline");
  for (const origin of origins) {
    if (signal?.aborted) break;
    try {
      const status = decodeStatus(await http(origin, "/status", signal ? { signal } : {}));
      if (expectedId && status.serverId !== expectedId)
        throw new MobileConnectionError("identity-changed");
      checkVersion(status);
      return { origin, status };
    } catch (error) {
      if (error instanceof MobileConnectionError) {
        if (error.state === "rate-limited" || error.state === "update-required") throw error;
        failed = error;
      }
    }
  }
  throw failed;
}

export async function pairPhone(
  input: PairingAddress,
  device: {
    deviceName: string;
    platform: "ios" | "android";
    appVersion: string;
    bundleId: string;
  },
): Promise<PairedServer> {
  const { origin, status } = await findOrigin(input.origins, input.serverId);
  const paired = decodePair(await http(origin, "/pair", { body: { code: input.code, ...device } }));
  if (paired.serverId !== status.serverId) throw new MobileConnectionError("identity-changed");
  return {
    deviceToken: paired.deviceToken,
    deviceId: paired.deviceId,
    serverId: paired.serverId,
    profileName: paired.profileName,
    deviceName: device.deviceName,
    origins: input.origins,
  };
}

export function readMobileShell(
  origin: string,
  server: PairedServer,
  incarnation: string,
  signal: AbortSignal,
) {
  return http(origin, "/shell?incarnation=" + encodeURIComponent(incarnation), {
    token: server.deviceToken,
    signal,
  });
}

type Pending = {
  resolve: (body: unknown) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
};
export type MobileSocket = Awaited<ReturnType<typeof connectMobile>>;

export async function connectMobile(
  server: PairedServer,
  signal: AbortSignal,
  handlers: {
    push: (channel: string, body: unknown) => void;
    disconnected: (error: MobileConnectionError, slow: boolean) => void;
  },
) {
  const diagnose = async () => {
    const { origin } = await findOrigin(server.origins, server.serverId, signal);
    const bootstrap = decodeBootstrap(
      await http(origin, "/bootstrap", { token: server.deviceToken, signal }),
    );
    if (bootstrap.serverId !== server.serverId) throw new MobileConnectionError("identity-changed");
    checkVersion(bootstrap);
    return { origin, bootstrap };
  };
  const { origin, bootstrap } = await diagnose();
  if (signal.aborted) throw new MobileConnectionError("offline");
  const endpoint =
    origin.replace(/^http/, "ws") + MOBILE_ROOT + "/socket?mobileApi=" + MOBILE_API_VERSION;
  // React Native adds the headers argument to the standard constructor.
  const NativeWebSocket = WebSocket as unknown as new (
    endpoint: string,
    protocols: string[],
    options: { headers: Record<string, string> },
  ) => WebSocket;
  const socket = new NativeWebSocket(endpoint, [], {
    headers: { Authorization: "Bearer " + server.deviceToken },
  });
  const pending = new Map<string, Pending>();
  let nextId = 0;
  let alive = true;
  let welcomed = false;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  let drain: (() => void) | undefined;
  let rejectWelcome: (error: MobileConnectionError) => void = () => {};

  const end = (error: MobileConnectionError, slow = false) => {
    if (!alive) return;
    alive = false;
    clearTimeout(deadline);
    signal.removeEventListener("abort", abort);
    for (const call of pending.values()) {
      clearTimeout(call.timeout);
      call.reject(error);
    }
    pending.clear();
    drain?.();
    socket.close();
    if (!welcomed) rejectWelcome(error);
    else if (!signal.aborted) handlers.disconnected(error, slow);
  };
  const abort = () => end(new MobileConnectionError("offline"));
  signal.addEventListener("abort", abort, { once: true });

  function armHeartbeat() {
    clearTimeout(deadline);
    deadline = setTimeout(() => end(new MobileConnectionError("offline")), 35_000);
  }

  const welcome = await new Promise<typeof MobileBootstrap.Type>((resolve, reject) => {
    rejectWelcome = reject;
    let diagnosing = false;
    async function handshakeFailed() {
      if (!alive || diagnosing) return;
      diagnosing = true;
      clearTimeout(deadline);
      try {
        await diagnose();
        end(new MobileConnectionError("offline"));
      } catch (error) {
        end(error instanceof MobileConnectionError ? error : new MobileConnectionError("offline"));
      }
    }
    deadline = setTimeout(() => {
      // The HTTP diagnosis has its own deadline. Tear down the pending upgrade.
      socket.close();
      void handshakeFailed();
    }, DEADLINE);
    socket.onclose = ({ code }) => {
      if (!alive) return;
      if (code === MOBILE_CLOSE.upgradeRequired)
        return end(new MobileConnectionError("update-required"));
      if (code === MOBILE_CLOSE.revoked) return end(new MobileConnectionError("revoked"));
      if (code === MOBILE_CLOSE.disabled) return end(new MobileConnectionError("access-off"));
      if (!welcomed) void handshakeFailed();
      else end(new MobileConnectionError("offline"), code === 1013);
    };
    socket.onmessage = ({ data }) => {
      if (!alive || typeof data !== "string") return;
      try {
        const frame = JSON.parse(data) as {
          channel?: string;
          body?: unknown;
          id?: string;
          ok?: boolean;
          error?: { code?: string; retryAfterMs?: number };
        };
        if (!welcomed) {
          if (frame.channel !== "mobile.welcome") throw new Error();
          const info = decodeBootstrap(frame.body);
          if (
            info.serverId !== server.serverId ||
            info.backendIncarnation !== bootstrap.backendIncarnation
          ) {
            end(
              new MobileConnectionError(
                info.serverId !== server.serverId ? "identity-changed" : "offline",
              ),
            );
            return;
          }
          welcomed = true;
          armHeartbeat();
          resolve(info);
          return;
        }
        if (frame.channel) {
          if (frame.channel === "mobile.batch") armHeartbeat();
          handlers.push(frame.channel, frame.body);
          return;
        }
        if (frame.id === undefined) throw new Error();
        const call = pending.get(frame.id);
        if (!call) return;
        clearTimeout(call.timeout);
        pending.delete(frame.id);
        if (frame.ok === true) call.resolve(frame.body);
        else
          call.reject(
            new MobileRpcError(frame.error?.code ?? "rejected", frame.error?.retryAfterMs),
          );
        if (!pending.size) drain?.();
      } catch {
        if (!welcomed) end(new MobileConnectionError("offline"));
        else handlers.push("mobile.resync", undefined);
      }
    };
  });

  return {
    origin,
    welcome,
    rpc<M extends Method>(method: M, body: Body<M>): Promise<unknown> {
      return new Promise((resolve, reject) => {
        if (!alive || socket.readyState !== WebSocket.OPEN)
          throw new MobileConnectionError("offline");
        const id = String(++nextId);
        const timeout = setTimeout(() => {
          pending.delete(id);
          reject(new MobileRpcError("timeout"));
          if (!pending.size) drain?.();
        }, DEADLINE);
        pending.set(id, { resolve, reject, timeout });
        try {
          socket.send(JSON.stringify({ id, method, body }));
        } catch (error) {
          clearTimeout(timeout);
          pending.delete(id);
          reject(error);
        }
      });
    },
    async drain() {
      if (!pending.size) return;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          drain = undefined;
          resolve();
        }, 5000);
        drain = () => {
          drain = undefined;
          clearTimeout(timer);
          resolve();
        };
      });
    },
  };
}
