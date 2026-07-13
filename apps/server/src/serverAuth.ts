import * as Crypto from "node:crypto";
import type * as Http from "node:http";

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

interface SessionRecord {
  readonly expiresAt: number;
}

interface AuthFailureBucket {
  readonly failures: number;
  readonly windowStartedAt: number;
  readonly blockedUntil: number;
}

export interface ServerAuthOptions {
  readonly now?: () => number;
  readonly failureWindowMs?: number;
  readonly lockoutMs?: number;
  readonly maxFailuresPerSource?: number;
  readonly maxFailuresGlobal?: number;
  readonly allowedWebSocketOrigins?: ReadonlyArray<string>;
}

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
}

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

function requestUsesTls(request: Http.IncomingMessage): boolean {
  if ((request.socket as { encrypted?: boolean }).encrypted === true) return true;
  const forwardedProto = request.headers["x-forwarded-proto"];
  const firstProto = (Array.isArray(forwardedProto) ? forwardedProto[0] : forwardedProto)
    ?.split(",", 1)[0]
    ?.trim()
    .toLowerCase();
  return firstProto === "https";
}

function sessionCookie(
  value: string,
  request: Http.IncomingMessage,
  maxAgeSeconds: number,
): string {
  return [
    `${AUTH_COOKIE_NAME}=${value}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Strict",
    `Max-Age=${maxAgeSeconds}`,
    ...(requestUsesTls(request) ? ["Secure"] : []),
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

  const recordAuthFailure = (source: string, timestamp: number): number => {
    const sourceFailures = nextFailureBucket(
      authFailuresBySource.get(source),
      timestamp,
      maxFailuresPerSource,
    );
    authFailuresBySource.set(source, sourceFailures);
    globalAuthFailures = nextFailureBucket(globalAuthFailures, timestamp, maxFailuresGlobal);
    return Math.max(sourceFailures.blockedUntil, globalAuthFailures.blockedUntil);
  };

  const respondRateLimited = (
    response: Http.ServerResponse,
    blockedUntil: number,
    timestamp: number,
  ) => {
    respond(
      response,
      429,
      JSON.stringify({ error: "Too many authentication attempts. Try again later." }),
      { "Retry-After": String(Math.max(1, Math.ceil((blockedUntil - timestamp) / 1_000))) },
    );
  };

  const pruneExpiredSessions = (now = Date.now()) => {
    for (const [token, session] of sessions) {
      if (session.expiresAt <= now) sessions.delete(token);
    }
  };

  const hasValidSession = (request: Http.IncomingMessage): boolean => {
    if (!enabled) return true;
    const token = parseCookies(request.headers.cookie).get(AUTH_COOKIE_NAME);
    if (!token) return false;
    const timestamp = now();
    const session = sessions.get(token);
    if (!session || session.expiresAt <= timestamp) {
      sessions.delete(token);
      return false;
    }
    return true;
  };

  const hasValidBearer = (request: Http.IncomingMessage): boolean => {
    if (!enabled) return true;
    return secretsEqual(expectedToken, bearerToken(request));
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
      const token = parseCookies(request.headers.cookie).get(AUTH_COOKIE_NAME);
      if (token) sessions.delete(token);
      respond(response, 204, "", {
        "Set-Cookie": sessionCookie("deleted", request, 0),
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

    const source = sourceAddress(request);
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
        "Set-Cookie": sessionCookie(sessionToken, request, Math.floor(AUTH_SESSION_TTL_MS / 1_000)),
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
    // loopback so they cannot leak on remote URLs or proxy access logs.
    const legacyToken = url.searchParams.get("token") ?? "";
    return isLoopbackAddress(sourceAddress(request)) && secretsEqual(expectedToken, legacyToken);
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
    return (
      (parsed.protocol === "http:" || parsed.protocol === "https:") &&
      normalizedHost(parsed.host) === normalizedHost(requestHost)
    );
  };

  return {
    enabled,
    handleHttpRequest,
    isHttpRequestAuthenticated: isAuthenticated,
    isWebSocketRequestAuthenticated,
    isWebSocketOriginAllowed,
  };
}

export function isPrivateHttpPath(pathname: string): boolean {
  return pathname.startsWith("/attachments/") || pathname.startsWith("/api/");
}
