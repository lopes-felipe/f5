import http from "node:http";
import type { Duplex } from "node:stream";
import { promisify } from "node:util";
import { gzip } from "node:zlib";
import {
  MOBILE_API_VERSION,
  MOBILE_CLOSE,
  MOBILE_ROOT,
  MobilePairRequest,
  MobileRequestEnvelope,
  mobileMethods,
  type MobileErrorCode,
  type MobileBootstrap,
  type MobileShell,
} from "@t3tools/contracts/mobile/v1";
import { Effect, Schema } from "effect";
import { WebSocket, WebSocketServer } from "ws";

import type { makeMobileDeviceStore, MobileDevice } from "./deviceStore.ts";
import { makeMobileAuth } from "./mobileAuth.ts";
import { formatMobileHost, type TailscaleInterface } from "./tailscale.ts";

type Store = Effect.Success<typeof makeMobileDeviceStore>;
type Method = keyof typeof mobileMethods;
export type MobileCall = {
  [K in Method]: { method: K; body: (typeof mobileMethods)[K]["Type"] };
}[Method];

const compress = promisify(gzip);
const MAX_REQUEST_BYTES = 64 * 1024;
const MAX_BUFFERED_BYTES = 1024 * 1024;
const decodePair = Schema.decodeUnknownSync(MobilePairRequest);
const decodeEnvelope = Schema.decodeUnknownSync(MobileRequestEnvelope);

export class MobileRouteError extends Error {
  constructor(
    readonly code: MobileErrorCode,
    readonly retryAfterMs?: number,
  ) {
    super(code);
  }
}

export interface MobilePeer {
  device: MobileDevice;
  send(channel: string, body: unknown): void;
  onClose(callback: () => void): void;
}

export function makeMobileListener(options: {
  network: TailscaleInterface;
  port: number;
  choosePort?: boolean;
  onError?: () => void;
  bootstrap: () => typeof MobileBootstrap.Type;
  store: Store;
  auth: ReturnType<typeof makeMobileAuth<MobileDevice>>;
  readShell: () => Promise<typeof MobileShell.Type>;
  attachments?: (
    request: http.IncomingMessage,
    response: http.ServerResponse,
    url: URL,
    deviceId: string,
  ) => Promise<boolean>;
  call: (peer: MobilePeer, call: MobileCall) => Promise<unknown>;
}) {
  const { network, port, bootstrap, store, auth } = options;
  let boundPort = port;
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_REQUEST_BYTES });
  const socketsByDeviceId = new Map<string, Set<WebSocket>>();
  let closed = false;

  function send(socket: WebSocket, envelope: unknown) {
    if (socket.readyState !== WebSocket.OPEN) return;
    const data = JSON.stringify(envelope);
    const bytes = Buffer.byteLength(data);
    if (bytes > MAX_BUFFERED_BYTES) {
      const id = (envelope as { id?: string }).id;
      if (id) send(socket, { id, ok: false, error: { code: "rejected" } });
      return;
    }
    if (socket.bufferedAmount + bytes > MAX_BUFFERED_BYTES) {
      socket.close(1013);
      return;
    }
    socket.send(data, (error) => {
      if (error) socket.terminate();
    });
  }

  function allowedHost(request: http.IncomingMessage) {
    const host = request.headers.host?.toLowerCase();
    const addressHost = formatMobileHost(network.address, boundPort);
    const dnsHost = network.magicDnsName ? formatMobileHost(network.magicDnsName, boundPort) : null;
    return host === addressHost.toLowerCase() || (dnsHost !== null && host === dnsHost);
  }

  function routeUrl(request: http.IncomingMessage) {
    if (!request.url?.startsWith("/") || request.url.startsWith("//")) return null;
    return URL.parse(request.url, "http://mobile.invalid");
  }

  function write(response: http.ServerResponse, code: number, body: unknown, extra = {}) {
    if (response.destroyed || response.writableEnded) return;
    if (response.headersSent) {
      response.destroy();
      return;
    }
    response.writeHead(code, {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      ...extra,
    });
    response.end(JSON.stringify(body));
  }

  async function pair(
    request: http.IncomingMessage,
    response: http.ServerResponse,
    source: string,
  ) {
    if (
      request.headers["content-type"]?.split(";")[0]?.trim().toLowerCase() !== "application/json"
    ) {
      write(response, 415, { error: "invalid-request" });
      return;
    }
    // Pairing bodies are small. Bound reads even for chunked requests.
    const chunks: Buffer[] = [];
    let bytes = 0;
    const deadline = setTimeout(() => request.destroy(), 10_000);
    try {
      for await (const chunk of request.iterator({ destroyOnReturn: false })) {
        bytes += chunk.length;
        if (bytes > 4096) {
          write(response, 413, { error: "invalid-request" }, { Connection: "close" });
          return;
        }
        chunks.push(chunk);
      }
    } finally {
      clearTimeout(deadline);
    }
    const retryAfter = auth.retryAfter(source);
    if (retryAfter) {
      write(response, 429, { error: "busy" }, { "Retry-After": retryAfter });
      return;
    }
    let input: typeof MobilePairRequest.Type;
    try {
      input = decodePair(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    } catch {
      auth.recordFailure(source);
      write(response, 401, { error: "invalid-code" });
      return;
    }
    if (closed) {
      write(response, 503, { error: "disabled" });
      return;
    }
    // This synchronous claim precedes the first await. Concurrent exchanges
    // cannot both reach the insert, including when the database is contended.
    if (!auth.consumeCode(input.code)) {
      auth.recordFailure(source);
      write(response, 401, { error: "invalid-code" });
      return;
    }
    const device = await Effect.runPromise(store.create(input));
    const { serverId, serverVersion, mobileApi, profileName } = bootstrap();
    write(response, 200, { serverId, serverVersion, mobileApi, profileName, ...device });
  }

  async function handle(request: http.IncomingMessage, response: http.ServerResponse) {
    if (closed) return write(response, 503, { error: "disabled" });
    if (!allowedHost(request)) return write(response, 403, { error: "forbidden" });
    const url = routeUrl(request);
    const route = request.method + " " + url?.pathname;
    if (route === "GET " + MOBILE_ROOT + "/status") {
      const { serverId, mobileApi, serverVersion } = bootstrap();
      return write(response, 200, { serverId, mobileApi, serverVersion });
    }
    const pairing = route === "POST " + MOBILE_ROOT + "/pair";
    const attachment =
      url !== null &&
      (route === "POST " + MOBILE_ROOT + "/attachments/uploads" ||
        ((request.method === "GET" || request.method === "HEAD") &&
          url.pathname.startsWith(MOBILE_ROOT + "/attachments/")));
    if (
      !pairing &&
      !attachment &&
      route !== "GET " + MOBILE_ROOT + "/bootstrap" &&
      route !== "GET " + MOBILE_ROOT + "/shell"
    ) {
      return write(response, 404, { error: "not-found" });
    }
    const source = request.socket.remoteAddress ?? "";
    const device = auth.authenticate(request.headers.authorization);
    const retryAfter = pairing || !device ? auth.retryAfter(source) : 0;
    if (retryAfter) return write(response, 429, { error: "busy" }, { "Retry-After": retryAfter });
    if (pairing) return pair(request, response, source);
    if (!device || url?.searchParams.has("token")) {
      if (!retryAfter && !auth.retryAfter(source)) auth.recordFailure(source);
      return write(response, 401, { error: "unauthorized" });
    }
    store.touch(device);
    if (attachment) {
      if (await options.attachments?.(request, response, url, device.device_id)) return;
      return write(response, 404, { error: "not-found" });
    }
    const info = bootstrap();
    if (route.endsWith("/bootstrap")) return write(response, 200, info);
    if (url?.searchParams.get("incarnation") !== info.backendIncarnation) {
      return write(response, 409, { error: "backend-replaced" });
    }
    if (!info.ready) return write(response, 503, { error: "starting" });
    const shell = await options.readShell();
    const body = await compress(JSON.stringify(shell));
    if (!store.active(device)) return write(response, 401, { error: "unauthorized" });
    if (closed) return write(response, 503, { error: "disabled" });
    if (response.destroyed) return;
    response.writeHead(200, {
      "Content-Type": "application/json",
      "Content-Encoding": "gzip",
      "Cache-Control": "no-store",
      "Content-Length": body.length,
    });
    response.end(body);
  }

  const server = http.createServer(
    {
      requestTimeout: 600_000,
      headersTimeout: 5000,
      keepAliveTimeout: 5000,
      maxHeaderSize: 8192,
    },
    (request, response) => {
      void handle(request, response).catch(() => write(response, 500, { error: "rejected" }));
    },
  );
  server.maxConnections = 64;
  let listening = false;
  server.on("error", () => {
    if (listening && !closed) options.onError?.();
  });

  function reject(socket: Duplex, status: number, retryAfter = 0) {
    const retryHeader = retryAfter ? "Retry-After: " + retryAfter + "\r\n" : "";
    socket.end(
      "HTTP/1.1 " +
        status +
        " " +
        http.STATUS_CODES[status] +
        "\r\n" +
        retryHeader +
        "Connection: close\r\nContent-Length: 0\r\n\r\n",
    );
  }

  server.on("upgrade", (request, connection, head) => {
    connection.on("error", () => connection.destroy());
    if (closed) return reject(connection, 503);
    if (!allowedHost(request)) return reject(connection, 403);
    const url = routeUrl(request);
    if (!url || url.pathname !== MOBILE_ROOT + "/socket") return reject(connection, 404);
    const source = request.socket.remoteAddress ?? "";
    const device = auth.authenticate(request.headers.authorization);
    if (!device || url.searchParams.has("token")) {
      const retryAfter = auth.retryAfter(source);
      if (retryAfter) return reject(connection, 429, retryAfter);
      auth.recordFailure(source);
      return reject(connection, 401);
    }
    wss.handleUpgrade(request, connection, head, (socket) => {
      socket.on("error", () => socket.terminate());
      if (closed || !store.active(device)) {
        socket.close(closed ? MOBILE_CLOSE.disabled : MOBILE_CLOSE.revoked);
        return;
      }
      const info = bootstrap();
      const versions = url.searchParams.getAll("mobileApi");
      const query = versions.length === 1 ? (versions[0] ?? "") : "";
      const version = /^[0-9]+$/.test(query) ? Number(query) : NaN;
      if (
        !Number.isSafeInteger(version) ||
        version < info.mobileApi.min ||
        version > MOBILE_API_VERSION
      ) {
        socket.close(
          MOBILE_CLOSE.upgradeRequired,
          JSON.stringify({
            error: "upgrade-required",
            mobileApi: info.mobileApi,
          }),
        );
        return;
      }
      const sockets = socketsByDeviceId.get(device.device_id) ?? new Set<WebSocket>();
      sockets.add(socket);
      socketsByDeviceId.set(device.device_id, sockets);
      const peer: MobilePeer = {
        device,
        send: (channel, body) => send(socket, { channel, body }),
        onClose: (callback) => socket.once("close", callback),
      };
      let pending = 0;
      socket.on("close", () => {
        sockets.delete(socket);
        if (sockets.size === 0 && socketsByDeviceId.get(device.device_id) === sockets)
          socketsByDeviceId.delete(device.device_id);
      });
      socket.on("message", (data, binary) => {
        if (binary || closed || !store.active(device)) return;
        if (pending >= 8) {
          socket.close(1013);
          return;
        }
        let request: typeof MobileRequestEnvelope.Type;
        try {
          request = decodeEnvelope(JSON.parse(data.toString()));
        } catch {
          socket.close(1007);
          return;
        }
        const errorReply = (code: MobileErrorCode, retryAfterMs?: number) =>
          send(socket, { id: request.id, ok: false, error: { code, retryAfterMs } });
        if (!Object.hasOwn(mobileMethods, request.method)) {
          errorReply("forbidden");
          return;
        }
        const method = request.method as Method;
        let call: MobileCall;
        try {
          const body = Schema.decodeUnknownSync(
            mobileMethods[method] as Schema.Top & { DecodingServices: never },
          )(request.body);
          call = { method, body } as MobileCall;
        } catch {
          errorReply("invalid-request");
          return;
        }
        store.touch(device);
        pending++;
        void options
          .call(peer, call)
          .then(
            (body) => {
              if (store.active(device) && !closed) send(socket, { id: request.id, ok: true, body });
            },
            (error: unknown) => {
              if (error instanceof MobileRouteError) errorReply(error.code, error.retryAfterMs);
              else errorReply("rejected");
            },
          )
          .finally(() => pending--);
      });
      store.touch(device);
      peer.send("mobile.welcome", info);
    });
  });

  return {
    async listen() {
      const bind = (candidate: number) =>
        new Promise<number>((resolve, rejectListen) => {
          function onError(error: Error) {
            server.removeListener("listening", onListening);
            rejectListen(error);
          }
          function onListening() {
            server.removeListener("error", onError);
            const address = server.address();
            if (!address || typeof address === "string")
              return rejectListen(new Error("Missing mobile listener address"));
            boundPort = address.port;
            listening = true;
            resolve(boundPort);
          }
          server.once("error", onError);
          server.once("listening", onListening);
          server.listen({ host: network.address, port: candidate });
        });
      try {
        return await bind(port);
      } catch (error) {
        if (options.choosePort && (error as NodeJS.ErrnoException).code === "EADDRINUSE")
          return bind(0);
        throw error;
      }
    },
    revoke(id: string) {
      const sockets = socketsByDeviceId.get(id);
      socketsByDeviceId.delete(id);
      for (const socket of sockets ?? []) socket.close(MOBILE_CLOSE.revoked);
    },
    async close() {
      if (closed) return;
      closed = true;
      const finished = new Promise<void>((resolve) => server.close(() => resolve()));
      for (const socket of wss.clients) socket.close(MOBILE_CLOSE.disabled);
      const timeout = setTimeout(() => {
        for (const socket of wss.clients) socket.terminate();
        server.closeAllConnections();
      }, 1000);
      await Promise.all([finished, new Promise<void>((resolve) => wss.close(() => resolve()))]);
      clearTimeout(timeout);
    },
  };
}
