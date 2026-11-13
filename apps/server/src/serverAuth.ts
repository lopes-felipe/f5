import * as Crypto from "node:crypto";
import type * as Http from "node:http";
import * as Net from "node:net";

const AUTH_SESSION_PATH = "/auth/session";
const AUTH_STATUS_PATH = "/auth/status";
const AUTH_LOGOUT_PATH = "/auth/logout";
const AUTH_COOKIE_NAME = "f5_session";
const AUTH_SESSION_TTL_MS = 12 * 60 * 60 * 1_000;
const MAX_AUTH_REQUEST_BYTES = 4 * 1024;
const AUTH_FAILURE_WINDOW_MS = 60 * 1_000;
const AUTH_LOCKOUT_MS = 60 * 1_000;
const MAX_AUTH_FAILURES_PER_SOURCE = 5;
const MAX_AUTH_FAILURES_GLOBAL = 100;

export const MIN_REMOTE_AUTH_TOKEN_BYTES = 24;
/** Environment variable that carries the backend's WebSocket/HTTP credential into the server. */
export const SERVER_AUTH_TOKEN_ENV = "T3CODE_AUTH_TOKEN";

interface SessionRecord {
  readonly expiresAt: number;
}

interface AuthFailureBucket {
  readonly failures: number;
  readonly windowStartedAt: number;
  readonly blockedUntil: number;
}

export interface ServerAuthOptions {
  readonly profileId?: string;
  readonly now?: () => number;
  readonly failureWindowMs?: number;
  readonly lockoutMs?: number;
  readonly maxFailuresPerSource?: number;
  readonly maxFailuresGlobal?: number;
  readonly allowedWebSocketOrigins?: ReadonlyArray<string>;
  /**
   * Addresses and CIDR ranges of reverse proxies. Only a listed proxy's `X-Forwarded-For` is
   * believed, loopback included: a tunnel or a proxy that passes the header through looks the
   * same from here, and its clients would choose their own address. `X-Forwarded-Proto` is
   * honored from loopback as well as from listed proxies. See {@link makeTrustedProxyCheck}.
   */
  readonly trustedProxies?: ReadonlyArray<string>;
}

/** Whether a socket peer address is a reverse proxy whose forwarded headers are honored. */
export type TrustedProxyCheck = (address: string) => boolean;

/** Headers a proxy adds. A request that carries one did not come straight from a local client. */
const FORWARDING_HEADERS = [
  "forwarded",
  "via",
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-port",
  "x-forwarded-proto",
  "x-real-ip",
] as const;

export interface ServerAuth {
  readonly enabled: boolean;
  readonly handleHttpRequest: (
    request: Http.IncomingMessage,
    response: Http.ServerResponse,
    url: URL,
  ) => Promise<boolean>;
  readonly isHttpRequestAuthenticated: (request: Http.IncomingMessage) => boolean;
  readonly isWebSocketRequestAuthenticated: (request: Http.IncomingMessage, url: URL) => boolean;
  readonly isWebSocketOriginAllowed: (request: Http.IncomingMessage) => boolean;
  /**
   * False when a token-less server is addressed under a name that is not loopback.
   *
   * Without a token the origin check is the only barrier, and it compares the Origin with the
   * request's own Host. A page on `attacker.example:<port>` whose DNS answer is switched to
   * 127.0.0.1 (DNS rebinding) sends matching values for both, so the Host itself must be one a
   * loopback listener can legitimately be reached under. A token makes the name irrelevant.
   */
  readonly isRequestHostAllowed: (request: Http.IncomingMessage) => boolean;
  /** {@link externalRequestOrigin} under this server's trusted proxies. */
  readonly externalRequestOrigin: (request: Http.IncomingMessage) => string | null;
  /**
   * The peer address when the request carries `X-Forwarded-Proto` from a peer that is not a
   * trusted proxy, so the header was ignored; null otherwise. For telling an operator why a
   * proxied request was refused.
   */
  readonly ignoredForwardedProtoPeer: (request: Http.IncomingMessage) => string | null;
  /**
   * Seconds until this request's bearer token will be checked again, when wrong tokens from
   * its client have locked that client out; null otherwise. Lets a refusal say "wait" (429)
   * instead of "wrong credential" (401), which a client holding the right token would misread.
   */
  readonly bearerRetryAfterSeconds: (request: Http.IncomingMessage) => number | null;
}

export const AUTH_RATE_LIMITED_MESSAGE = "Too many authentication attempts. Try again later.";

export const REQUEST_HOST_NOT_ALLOWED_MESSAGE =
  "This F5 server has no auth token, so it only answers requests addressed to localhost. " +
  "Start it with --auth-token to reach it under another name.";

function parseCookies(header: string | undefined): ReadonlyMap<string, string> {
  const result = new Map<string, string>();
  for (const segment of header?.split(";") ?? []) {
    const separator = segment.indexOf("=");
    if (separator <= 0) continue;
    const name = segment.slice(0, separator).trim();
    const value = segment.slice(separator + 1).trim();
    if (name.length === 0 || value.length === 0) continue;
    result.set(name, value);
  }
  return result;
}

function secretsEqual(expected: string, provided: string): boolean {
  const expectedBytes = Buffer.from(expected);
  const providedBytes = Buffer.from(provided);
  return (
    expectedBytes.length === providedBytes.length &&
    Crypto.timingSafeEqual(expectedBytes, providedBytes)
  );
}

/**
 * The origin the browser used for this request (Host plus TLS/forwarded scheme).
 * Unlike `new URL(req.url, base)`, this matches what CSP sees in real deployments.
 */
export function externalRequestOrigin(
  request: Http.IncomingMessage,
  isTrustedProxy: TrustedProxyCheck = isLoopbackAddress,
): string | null {
  const host = request.headers.host?.trim();
  if (!host || !/^[A-Za-z0-9.-]+(?::\d{1,5})?$|^\[[0-9A-Fa-f:.]+\](?::\d{1,5})?$/u.test(host))
    return null;
  return `${requestUsesTls(request, isTrustedProxy) ? "https" : "http"}://${host.toLowerCase()}`;
}

/**
 * Whether the browser reached this server over TLS: on the socket itself, or as a trusted
 * reverse proxy reports it. `X-Forwarded-Proto` from any other peer is ignored, because the
 * client wrote it.
 */
export function requestUsesTls(
  request: Http.IncomingMessage,
  isTrustedProxy: TrustedProxyCheck = isLoopbackAddress,
): boolean {
  if ((request.socket as { encrypted?: boolean }).encrypted === true) return true;
  if (!isTrustedProxy(sourceAddress(request))) return false;
  return forwardedProto(request) === "https";
}

function forwardedProto(request: Http.IncomingMessage): string | undefined {
  const header = request.headers["x-forwarded-proto"];
  return (Array.isArray(header) ? header[0] : header)?.split(",", 1)[0]?.trim().toLowerCase();
}

function sessionCookie(
  cookieName: string,
  value: string,
  secure: boolean,
  maxAgeSeconds: number,
): string {
  return [
    `${cookieName}=${value}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Strict",
    `Max-Age=${maxAgeSeconds}`,
    ...(secure ? ["Secure"] : []),
  ].join("; ");
}

function readRequestBody(request: Http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    request.on("data", (chunk: Buffer | string) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += buffer.length;
      if (bytes > MAX_AUTH_REQUEST_BYTES) {
        reject(new Error("Authentication request is too large."));
        request.destroy();
        return;
      }
      chunks.push(buffer);
    });
    request.once("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.once("error", reject);
  });
}

function respond(
  response: Http.ServerResponse,
  statusCode: number,
  body = "",
  headers: Readonly<Record<string, string>> = {},
): void {
  response.writeHead(statusCode, {
    "Cache-Control": "no-store",
    "Content-Type": "application/json; charset=utf-8",
    ...headers,
  });
  response.end(body);
}

function normalizedHost(value: string): string {
  return value.trim().toLowerCase().replace(/\.$/u, "");
}

function normalizedOrigin(value: string): string | null {
  try {
    const parsed = new URL(value);
    if (
      !parsed.protocol ||
      !parsed.host ||
      parsed.username ||
      parsed.password ||
      parsed.search ||
      parsed.hash ||
      (parsed.pathname !== "" && parsed.pathname !== "/")
    ) {
      return null;
    }
    return `${parsed.protocol.toLowerCase()}//${normalizedHost(parsed.host)}`;
  } catch {
    return null;
  }
}

function sourceAddress(request: Http.IncomingMessage): string {
  return request.socket.remoteAddress?.trim().toLowerCase() || "unknown";
}

function isLoopbackAddress(value: string): boolean {
  const normalized = value.replace(/^::ffff:/u, "");
  return normalized === "::1" || /^127(?:\.\d{1,3}){3}$/u.test(normalized);
}

const MAX_FORWARDED_FOR_HOPS = 16;

/**
 * Builds the check for which socket peers are listed reverse proxies: the given IP addresses
 * and CIDR ranges (`10.0.0.5`, `172.16.0.0/12`, `fd00::/8`, `127.0.0.1`). Loopback is not
 * implied. Throws on an entry that is neither an address nor a range.
 */
export function makeTrustedProxyCheck(entries: ReadonlyArray<string> = []): TrustedProxyCheck {
  const listed = new Net.BlockList();
  for (const raw of entries) {
    const entry = raw.trim();
    if (entry.length === 0) continue;
    const [address = "", prefix, ...rest] = entry.split("/");
    const family = Net.isIP(address);
    const bits = prefix === undefined ? null : Number(prefix);
    if (
      family === 0 ||
      rest.length > 0 ||
      (bits !== null && (!/^\d{1,3}$/u.test(prefix ?? "") || bits > (family === 4 ? 32 : 128)))
    ) {
      throw new Error(
        `Invalid trusted proxy '${entry}'. Use an IP address or a CIDR range such as 10.0.0.0/8.`,
      );
    }
    const type = family === 4 ? "ipv4" : "ipv6";
    if (bits === null) listed.addAddress(address, type);
    else listed.addSubnet(address, bits, type);
  }
  return (address) => {
    const normalized = address.replace(/^::ffff:/u, "");
    const family = Net.isIP(normalized);
    return family !== 0 && listed.check(normalized, family === 4 ? "ipv4" : "ipv6");
  };
}

/** One `X-Forwarded-For` entry as a bare IP address, or null when it is not one. */
function forwardedAddress(entry: string): string | null {
  const value = entry.trim().toLowerCase();
  const bare =
    /^\[([0-9a-f:.]+)\](?::\d{1,5})?$/u.exec(value)?.[1] ??
    /^(\d{1,3}(?:\.\d{1,3}){3}):\d{1,5}$/u.exec(value)?.[1] ??
    value;
  return Net.isIP(bare) === 0 ? null : bare;
}

/**
 * The address of the client that made the request. For a direct connection, and for any peer
 * that is not a listed proxy, that is the socket peer. Behind listed proxies it is the nearest
 * `X-Forwarded-For` entry that is not itself a listed proxy: each proxy appends the address it
 * saw, so entries are believed from the right only as far as listed proxies vouch for them,
 * and anything a client wrote into the header itself is never reached.
 */
function clientAddress(request: Http.IncomingMessage, isTrustedProxy: TrustedProxyCheck): string {
  const peer = sourceAddress(request);
  if (!isTrustedProxy(peer)) return peer;
  const header = request.headers["x-forwarded-for"];
  const entries = (Array.isArray(header) ? header.join(",") : (header ?? ""))
    .split(",")
    .filter((entry) => entry.trim().length > 0)
    .slice(-MAX_FORWARDED_FOR_HOPS);
  let client = peer;
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const address = forwardedAddress(entries[index]!);
    if (address === null) break;
    client = address;
    if (!isTrustedProxy(address)) break;
  }
  return client;
}

/**
 * Whether the request came straight from a client on this machine: a loopback peer and no
 * header a proxy adds. A proxy or tunnel on this machine is a loopback peer too, so the
 * address alone does not say that. A tunnel that adds no header cannot be told apart.
 */
function isDirectLocalRequest(request: Http.IncomingMessage): boolean {
  return (
    isLoopbackAddress(sourceAddress(request)) &&
    FORWARDING_HEADERS.every((name) => request.headers[name] === undefined)
  );
}

/** The name in a Host header, without port, brackets or trailing dot; null when malformed. */
function hostHeaderName(value: string): string | null {
  const host = value.trim().toLowerCase();
  const bracketed = /^\[([0-9a-f:.]+)\](?::\d{1,5})?$/u.exec(host);
  if (bracketed) return bracketed[1] ?? null;
  const name = /^([a-z0-9.-]+)(?::\d{1,5})?$/u.exec(host)?.[1]?.replace(/\.$/u, "");
  return name ? name : null;
}

/** Names that always resolve to this machine: loopback addresses, `localhost` and its subdomains. */
function isLoopbackName(name: string): boolean {
  return name === "localhost" || name.endsWith(".localhost") || isLoopbackAddress(name);
}

function retryAfterSeconds(blockedUntil: number, timestamp: number): number {
  return Math.max(1, Math.ceil((blockedUntil - timestamp) / 1_000));
}

function bearerToken(request: Http.IncomingMessage): string {
  const authorization = request.headers.authorization;
  if (!authorization) return "";
  const match = /^Bearer\s+(.+)$/iu.exec(authorization);
  return match?.[1]?.trim() ?? "";
}

export function makeServerAuth(
  authToken: string | undefined,
  options: ServerAuthOptions = {},
): ServerAuth {
  if (options.profileId && !/^[0-9a-f]{32}$/.test(options.profileId))
    throw new Error("Invalid authentication profile identity.");
  const cookieName = options.profileId
    ? `${AUTH_COOKIE_NAME}_${options.profileId}`
    : AUTH_COOKIE_NAME;
  const expectedToken = authToken?.trim() ?? "";
  const enabled = expectedToken.length > 0;
  const sessions = new Map<string, SessionRecord>();
  const authFailuresBySource = new Map<string, AuthFailureBucket>();
  let globalAuthFailures: AuthFailureBucket | null = null;
  const now = options.now ?? Date.now;
  const failureWindowMs = options.failureWindowMs ?? AUTH_FAILURE_WINDOW_MS;
  const lockoutMs = options.lockoutMs ?? AUTH_LOCKOUT_MS;
  const maxFailuresPerSource = options.maxFailuresPerSource ?? MAX_AUTH_FAILURES_PER_SOURCE;
  const maxFailuresGlobal = options.maxFailuresGlobal ?? MAX_AUTH_FAILURES_GLOBAL;
  const allowedWebSocketOrigins = new Set(
    (options.allowedWebSocketOrigins ?? []).flatMap((origin) => {
      const normalized = normalizedOrigin(origin);
      return normalized === null ? [] : [normalized];
    }),
  );
  // Whose X-Forwarded-For names the client: listed proxies only.
  const isListedProxy = makeTrustedProxyCheck(options.trustedProxies);
  // Whose X-Forwarded-Proto is honored. It decides the cookie's Secure flag and the scheme an
  // Origin must use, nothing a limit depends on, so a proxy on this machine needs no listing.
  const isTrustedProxy: TrustedProxyCheck = (address) =>
    isLoopbackAddress(address) || isListedProxy(address);
  const usesTls = (request: Http.IncomingMessage) => requestUsesTls(request, isTrustedProxy);
  // Requests whose wrong token already counted, so one request is one failure.
  const countedTokenFailures = new WeakSet<Http.IncomingMessage>();

  const nextFailureBucket = (
    current: AuthFailureBucket | null | undefined,
    timestamp: number,
    maximum: number,
  ): AuthFailureBucket => {
    const active =
      current &&
      timestamp < Math.max(current.windowStartedAt + failureWindowMs, current.blockedUntil)
        ? current
        : null;
    const failures = (active?.failures ?? 0) + 1;
    return {
      failures,
      windowStartedAt: active?.windowStartedAt ?? timestamp,
      blockedUntil:
        failures >= maximum ? timestamp + lockoutMs : (active?.blockedUntil ?? timestamp),
    };
  };

  const pruneExpiredAuthFailures = (timestamp: number) => {
    for (const [source, bucket] of authFailuresBySource) {
      if (timestamp >= Math.max(bucket.windowStartedAt + failureWindowMs, bucket.blockedUntil)) {
        authFailuresBySource.delete(source);
      }
    }
    if (
      globalAuthFailures &&
      timestamp >=
        Math.max(
          globalAuthFailures.windowStartedAt + failureWindowMs,
          globalAuthFailures.blockedUntil,
        )
    ) {
      globalAuthFailures = null;
    }
  };

  const blockedUntilFor = (source: string, timestamp: number): number => {
    pruneExpiredAuthFailures(timestamp);
    return Math.max(
      authFailuresBySource.get(source)?.blockedUntil ?? timestamp,
      globalAuthFailures?.blockedUntil ?? timestamp,
    );
  };

  const sourceBlockedUntil = (source: string, timestamp: number): number => {
    pruneExpiredAuthFailures(timestamp);
    return authFailuresBySource.get(source)?.blockedUntil ?? timestamp;
  };

  const recordSourceFailure = (source: string, timestamp: number): number => {
    const sourceFailures = nextFailureBucket(
      authFailuresBySource.get(source),
      timestamp,
      maxFailuresPerSource,
    );
    authFailuresBySource.set(source, sourceFailures);
    return sourceFailures.blockedUntil;
  };

  const recordAuthFailure = (source: string, timestamp: number): number => {
    const sourceBlocked = recordSourceFailure(source, timestamp);
    globalAuthFailures = nextFailureBucket(globalAuthFailures, timestamp, maxFailuresGlobal);
    return Math.max(sourceBlocked, globalAuthFailures.blockedUntil);
  };

  const respondRateLimited = (
    response: Http.ServerResponse,
    blockedUntil: number,
    timestamp: number,
  ) => {
    respond(response, 429, JSON.stringify({ error: AUTH_RATE_LIMITED_MESSAGE }), {
      "Retry-After": String(retryAfterSeconds(blockedUntil, timestamp)),
    });
  };

  const pruneExpiredSessions = (now = Date.now()) => {
    for (const [token, session] of sessions) {
      if (session.expiresAt <= now) sessions.delete(token);
    }
  };

  const hasValidSession = (request: Http.IncomingMessage): boolean => {
    if (!enabled) return true;
    const token = parseCookies(request.headers.cookie).get(cookieName);
    if (!token) return false;
    const timestamp = now();
    const session = sessions.get(token);
    if (!session || session.expiresAt <= timestamp) {
      sessions.delete(token);
      return false;
    }
    return true;
  };

  /**
   * A bearer token is a guess at the same secret a login is, so a wrong one counts toward its
   * client's limit, and a locked-out client's token is not checked at all.
   *
   * Only the per-client limit applies. The limit across all clients would let anyone who can
   * reach the server keep every client with the right token out, by sending wrong ones.
   *
   * Requests straight from this machine are exempt: the desktop app reconnects from there,
   * and a stale local client must not be able to lock it out. A request a local proxy
   * forwards is not exempt, whatever address the proxy reports for it.
   */
  const hasValidBearer = (request: Http.IncomingMessage): boolean => {
    if (!enabled) return true;
    const presented = bearerToken(request);
    if (presented.length === 0) return false;
    const limited = !isDirectLocalRequest(request);
    const source = clientAddress(request, isListedProxy);
    const timestamp = now();
    if (limited && sourceBlockedUntil(source, timestamp) > timestamp) return false;
    if (secretsEqual(expectedToken, presented)) return true;
    if (limited && !countedTokenFailures.has(request)) {
      countedTokenFailures.add(request);
      recordSourceFailure(source, timestamp);
    }
    return false;
  };

  const bearerRetryAfterSeconds: ServerAuth["bearerRetryAfterSeconds"] = (request) => {
    if (!enabled || bearerToken(request).length === 0 || isDirectLocalRequest(request)) return null;
    const timestamp = now();
    const blockedUntil = sourceBlockedUntil(clientAddress(request, isListedProxy), timestamp);
    return blockedUntil > timestamp ? retryAfterSeconds(blockedUntil, timestamp) : null;
  };

  const isAuthenticated = (request: Http.IncomingMessage): boolean =>
    !enabled || hasValidSession(request) || hasValidBearer(request);

  const handleHttpRequest: ServerAuth["handleHttpRequest"] = async (request, response, url) => {
    if (url.pathname === AUTH_STATUS_PATH) {
      if (isAuthenticated(request)) {
        respond(response, 200, JSON.stringify({ authenticated: true, required: enabled }));
      } else {
        respond(response, 401, JSON.stringify({ authenticated: false, required: true }));
      }
      return true;
    }

    if (url.pathname === AUTH_LOGOUT_PATH) {
      if (request.method !== "POST") {
        respond(response, 405, JSON.stringify({ error: "Method not allowed." }), {
          Allow: "POST",
        });
        return true;
      }
      const token = parseCookies(request.headers.cookie).get(cookieName);
      if (token) sessions.delete(token);
      respond(response, 204, "", {
        "Set-Cookie": sessionCookie(cookieName, "deleted", usesTls(request), 0),
      });
      return true;
    }

    if (url.pathname !== AUTH_SESSION_PATH) return false;
    if (request.method !== "POST") {
      respond(response, 405, JSON.stringify({ error: "Method not allowed." }), { Allow: "POST" });
      return true;
    }
    if (!enabled) {
      respond(response, 204);
      return true;
    }

    // Behind a listed reverse proxy every client shares the proxy's address, so the limit
    // follows the client the proxy reports. Otherwise one client's failures would lock out
    // everyone. Clients of an unlisted proxy share its address and its limit.
    const source = clientAddress(request, isListedProxy);
    const requestStartedAt = now();
    const existingBlock = blockedUntilFor(source, requestStartedAt);
    if (existingBlock > requestStartedAt) {
      request.resume();
      respondRateLimited(response, existingBlock, requestStartedAt);
      return true;
    }

    try {
      const body = JSON.parse(await readRequestBody(request)) as { token?: unknown };
      const providedToken = typeof body.token === "string" ? body.token : "";
      if (!secretsEqual(expectedToken, providedToken)) {
        const failedAt = now();
        const blockedUntil = recordAuthFailure(source, failedAt);
        if (blockedUntil > failedAt) {
          respondRateLimited(response, blockedUntil, failedAt);
        } else {
          respond(response, 401, JSON.stringify({ error: "Invalid authentication token." }));
        }
        return true;
      }

      authFailuresBySource.delete(source);
      globalAuthFailures = null;
      pruneExpiredSessions(now());
      const sessionToken = Crypto.randomBytes(32).toString("base64url");
      sessions.set(sessionToken, { expiresAt: now() + AUTH_SESSION_TTL_MS });
      respond(response, 204, "", {
        "Set-Cookie": sessionCookie(
          cookieName,
          sessionToken,
          usesTls(request),
          Math.floor(AUTH_SESSION_TTL_MS / 1_000),
        ),
      });
    } catch {
      if (!response.writableEnded) {
        const failedAt = now();
        const blockedUntil = recordAuthFailure(source, failedAt);
        if (blockedUntil > failedAt) {
          respondRateLimited(response, blockedUntil, failedAt);
        } else {
          respond(response, 400, JSON.stringify({ error: "Invalid authentication request." }));
        }
      }
    }
    return true;
  };

  const isWebSocketRequestAuthenticated: ServerAuth["isWebSocketRequestAuthenticated"] = (
    request,
    url,
  ) => {
    if (isAuthenticated(request)) return true;
    // Preserve the loopback desktop bridge compatibility path. Browser-based
    // remote access exchanges the token for an HttpOnly cookie, while CLI
    // clients can use Authorization: Bearer. Query tokens are accepted only on
    // loopback so they cannot leak on remote URLs or proxy access logs. A
    // client that a local reverse proxy forwards for is not on loopback.
    const legacyToken = url.searchParams.get("token") ?? "";
    return isDirectLocalRequest(request) && secretsEqual(expectedToken, legacyToken);
  };

  const isWebSocketOriginAllowed: ServerAuth["isWebSocketOriginAllowed"] = (request) => {
    const origin = request.headers.origin;
    if (!origin) return true;
    const requestHost = request.headers.host;
    if (!requestHost) return false;
    const parsedOrigin = normalizedOrigin(origin);
    if (parsedOrigin === null) return false;
    if (allowedWebSocketOrigins.has(parsedOrigin)) return true;
    const parsed = new URL(parsedOrigin);
    const expectedProtocol = usesTls(request) ? "https:" : "http:";
    return (
      parsed.protocol === expectedProtocol &&
      normalizedHost(parsed.host) === normalizedHost(requestHost)
    );
  };

  const isRequestHostAllowed: ServerAuth["isRequestHostAllowed"] = (request) => {
    if (enabled) return true;
    // Only browsers can be rebound, and they always send Host.
    const header = request.headers.host;
    if (header === undefined) return true;
    const name = hostHeaderName(header);
    return name !== null && isLoopbackName(name);
  };

  return {
    enabled,
    handleHttpRequest,
    isHttpRequestAuthenticated: isAuthenticated,
    isWebSocketRequestAuthenticated,
    isWebSocketOriginAllowed,
    isRequestHostAllowed,
    externalRequestOrigin: (request) => externalRequestOrigin(request, isTrustedProxy),
    ignoredForwardedProtoPeer: (request) => {
      const peer = sourceAddress(request);
      return forwardedProto(request) !== undefined && !isTrustedProxy(peer) ? peer : null;
    },
    bearerRetryAfterSeconds,
  };
}

export { isPrivateHttpPath } from "@t3tools/shared/backendPaths";
