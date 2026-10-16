/**
 * A minimal OAuth 2.1 authorization server for the remote Agent Bridge
 * listener: authorization code with PKCE (S256) plus refresh, opaque hashed
 * tokens, no OIDC and no JWTs.
 *
 * - `issuer` is exactly the canonical public base URL; nothing is derived from
 *   request headers.
 * - Clients are client-metadata documents (CIMD, an https `client_id` on a
 *   trusted host) or dynamically registered (DCR, exact allowlisted redirects).
 * - `/oauth/authorize` works only inside the pairing window opened in F5. The
 *   decision is made in F5 (a browser reaching the tunnel has no F5 session);
 *   the browser page shows a match code and polls for the outcome.
 *
 * @module agentBridge/oauthServer
 */
import { createHash, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import type http from "node:http";

import {
  AGENT_BRIDGE_PAIRING_WINDOW_MS,
  AGENT_BRIDGE_SCOPES,
  type AgentBridgeClientKind,
  type AgentBridgePairingState,
  type AgentBridgeScope,
} from "@t3tools/contracts";
import { Effect } from "effect";

import { readRequestBody, RequestBodyTooLargeError, writeJson } from "../mcp/jsonRpcHttp.ts";
import type { AgentBridgeClientRecord, AgentBridgeStore } from "./AgentBridgeStore.ts";
import { OAuthStoreError, type OAuthStore } from "./OAuthStore.ts";
import type { OutboundHttps } from "./outboundHttps.ts";
import { SlidingWindowLimiter } from "./rateLimits.ts";

export const AUTHORIZE_REQUESTS_PER_HOUR = 10;
const CIMD_CACHE_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const MATCH_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export interface OAuthServerConfig {
  /** The canonical public base URL. */
  readonly issuer: string;
  readonly allowedRedirectUris: ReadonlyArray<string>;
  readonly trustedClientMetadataHosts: ReadonlyArray<string>;
}

export const resourceFor = (issuer: string) => `${issuer}/mcp`;
export const protectedResourceMetadataUrl = (issuer: string) =>
  `${issuer}/.well-known/oauth-protected-resource`;

export class OAuthDecisionError extends Error {}

interface PendingRequest {
  readonly requestId: string;
  readonly clientId: string;
  readonly clientName: string;
  readonly clientKind: AgentBridgeClientKind;
  readonly redirectUri: string;
  readonly state: string | null;
  readonly codeChallenge: string;
  readonly resource: string;
  readonly requestedScopes: ReadonlyArray<AgentBridgeScope>;
  readonly matchCode: string;
  readonly createdAt: number;
  readonly cimd: { readonly redirectUris: ReadonlyArray<string> } | null;
  outcome: { readonly redirect: string } | { readonly expired: true } | null;
}

export interface OAuthServerDeps {
  readonly store: OAuthStore;
  readonly clients: AgentBridgeStore;
  readonly config: () => OAuthServerConfig | null;
  readonly outbound: OutboundHttps;
  /** Called when pairing or client state changes (UI invalidation). */
  readonly onChanged: (affectedIds: ReadonlyArray<string>) => void;
  /** Called after a client's grant generation changed (tasks must be fenced). */
  readonly onGrantChanged: (clientId: string, reason: "granted" | "reused") => Promise<void>;
  readonly now?: () => number;
}

export interface OAuthServer {
  readonly handleRoute: (
    request: http.IncomingMessage,
    response: http.ServerResponse,
    pathname: string,
  ) => Promise<boolean>;
  /** Resolves an access token to its client, checking expiry, audience, revocation, and generation. */
  readonly authenticate: (
    token: string,
  ) => Promise<{ readonly client: AgentBridgeClientRecord; readonly familyId: string } | null>;
  readonly openPairingWindow: () => void;
  readonly pairingState: () => AgentBridgePairingState;
  readonly decide: (input: {
    readonly requestId: string;
    readonly approve: boolean;
    readonly scopes: ReadonlyArray<AgentBridgeScope>;
    readonly projectIds: ReadonlyArray<string>;
  }) => Promise<void>;
  /** Drops pairing state (the issuer changed or the listener stopped). */
  readonly reset: () => void;
}

const isScope = (value: string): value is AgentBridgeScope =>
  (AGENT_BRIDGE_SCOPES as ReadonlyArray<string>).includes(value);

const s256 = (verifier: string) => createHash("sha256").update(verifier).digest("base64url");

const safeEqual = (left: string, right: string) => {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
};

const escapeHtml = (value: string) =>
  value.replace(
    /[&<>"']/gu,
    (char) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char] ?? char,
  );

function writeHtml(
  response: http.ServerResponse,
  status: number,
  title: string,
  body: string,
  script?: string,
) {
  const nonce = randomBytes(16).toString("base64");
  response.writeHead(status, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "x-frame-options": "DENY",
    "referrer-policy": "no-referrer",
    "content-security-policy": `default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`,
  });
  response.end(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>${escapeHtml(title)}</title>
<style nonce="${nonce}">body{font:15px/1.5 system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem;color:#222}
.code{font:600 2rem ui-monospace,monospace;letter-spacing:.3rem}</style></head>
<body><h1>${escapeHtml(title)}</h1>${body}${script ? `<script nonce="${nonce}">${script}</script>` : ""}</body></html>`);
}

const oauthError = (
  response: http.ServerResponse,
  status: number,
  error: string,
  description: string,
  headers?: Readonly<Record<string, string>>,
) => writeJson(response, status, { error, error_description: description }, headers);

async function readForm(request: http.IncomingMessage): Promise<Record<string, string> | null> {
  const contentType = (request.headers["content-type"] ?? "").toLowerCase();
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > 64 * 1024) return null;
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  if (contentType.startsWith("application/json")) {
    try {
      const parsed = JSON.parse(text) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
      return Object.fromEntries(
        Object.entries(parsed).filter(
          (entry): entry is [string, string] => typeof entry[1] === "string",
        ),
      );
    } catch {
      return null;
    }
  }
  return Object.fromEntries(new URLSearchParams(text));
}

export function makeOAuthServer(deps: OAuthServerDeps): OAuthServer {
  const now = deps.now ?? Date.now;
  const authorizeLimiter = new SlidingWindowLimiter(AUTHORIZE_REQUESTS_PER_HOUR, HOUR_MS, now);
  const cimdCache = new Map<
    string,
    { readonly name: string; readonly redirectUris: ReadonlyArray<string>; readonly at: number }
  >();
  let windowOpenUntil: number | null = null;
  const requests = new Map<string, PendingRequest>();

  const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect);

  const windowOpen = () => windowOpenUntil !== null && windowOpenUntil > now();
  const expireStale = () => {
    const at = now();
    for (const [id, entry] of requests) {
      if (
        entry.outcome === null &&
        (!windowOpen() || at - entry.createdAt > AGENT_BRIDGE_PAIRING_WINDOW_MS)
      )
        entry.outcome = { expired: true };
      // Finished requests are kept briefly so the browser page can read the outcome.
      if (entry.outcome !== null && at - entry.createdAt > AGENT_BRIDGE_PAIRING_WINDOW_MS * 2)
        requests.delete(id);
    }
    if (windowOpenUntil !== null && windowOpenUntil <= at) windowOpenUntil = null;
  };
  const pending = () => {
    expireStale();
    return [...requests.values()].find((entry) => entry.outcome === null) ?? null;
  };

  const withIss = (target: string, params: Record<string, string | null>, issuer: string) => {
    const url = new URL(target);
    for (const [key, value] of Object.entries(params))
      if (value !== null) url.searchParams.set(key, value);
    url.searchParams.set("iss", issuer);
    return url.toString();
  };

  // ── client resolution ──

  const isCimdClientId = (clientId: string, config: OAuthServerConfig) => {
    try {
      const url = new URL(clientId);
      return (
        url.protocol === "https:" &&
        config.trustedClientMetadataHosts.some((host) => host.toLowerCase() === url.hostname)
      );
    } catch {
      return false;
    }
  };

  const fetchClientMetadata = async (clientId: string) => {
    const cached = cimdCache.get(clientId);
    if (cached && now() - cached.at < CIMD_CACHE_MS) return cached;
    const response = await deps.outbound({
      url: clientId,
      headers: { accept: "application/json" },
    });
    if (response.status !== 200) throw new Error("The client metadata document is unavailable.");
    const document = JSON.parse(response.body) as Record<string, unknown>;
    if (document.client_id !== clientId)
      throw new Error("The client metadata document names a different client.");
    const redirectUris = Array.isArray(document.redirect_uris)
      ? document.redirect_uris.filter((value): value is string => typeof value === "string")
      : [];
    const name =
      typeof document.client_name === "string" && document.client_name.trim().length > 0
        ? document.client_name.trim().slice(0, 100)
        : new URL(clientId).hostname;
    const entry = { name, redirectUris, at: now() };
    cimdCache.set(clientId, entry);
    return entry;
  };

  // ── routes ──

  const metadata = (
    response: http.ServerResponse,
    config: OAuthServerConfig,
    kind: "resource" | "server",
  ) => {
    const { issuer } = config;
    if (kind === "resource") {
      writeJson(response, 200, {
        resource: resourceFor(issuer),
        authorization_servers: [issuer],
        scopes_supported: [...AGENT_BRIDGE_SCOPES],
        bearer_methods_supported: ["header"],
        resource_name: "F5 Agent Bridge",
      });
      return;
    }
    writeJson(response, 200, {
      issuer,
      authorization_endpoint: `${issuer}/oauth/authorize`,
      token_endpoint: `${issuer}/oauth/token`,
      registration_endpoint: `${issuer}/oauth/register`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
      scopes_supported: [...AGENT_BRIDGE_SCOPES],
      client_id_metadata_document_supported: true,
      authorization_response_iss_parameter_supported: true,
    });
  };

  const register = async (
    request: http.IncomingMessage,
    response: http.ServerResponse,
    config: OAuthServerConfig,
  ) => {
    let body: unknown;
    try {
      body = await readRequestBody(request, 64 * 1024);
    } catch (cause) {
      oauthError(
        response,
        cause instanceof RequestBodyTooLargeError ? 413 : 400,
        "invalid_client_metadata",
        "Send the client metadata as JSON.",
      );
      return;
    }
    const metadataBody = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
    const redirectUris = Array.isArray(metadataBody.redirect_uris)
      ? metadataBody.redirect_uris.filter((value): value is string => typeof value === "string")
      : [];
    if (
      redirectUris.length === 0 ||
      redirectUris.some((uri) => !config.allowedRedirectUris.includes(uri))
    ) {
      oauthError(
        response,
        400,
        "invalid_redirect_uri",
        "Every redirect URI must exactly match one allowed in F5's Agent Bridge settings.",
      );
      return;
    }
    const method = metadataBody.token_endpoint_auth_method;
    if (method !== undefined && method !== "none") {
      oauthError(response, 400, "invalid_client_metadata", "Only public clients are supported.");
      return;
    }
    const name =
      typeof metadataBody.client_name === "string" && metadataBody.client_name.trim().length > 0
        ? metadataBody.client_name.trim().slice(0, 100)
        : "MCP client";
    const at = now();
    const outcome = await run(deps.store.registerDcrClient({ name, redirectUris, at }));
    if (!outcome.ok) {
      oauthError(
        response,
        outcome.reason === "rate" ? 429 : 400,
        "invalid_client_metadata",
        outcome.reason === "rate"
          ? "Too many registrations this hour."
          : "Too many registered clients. Revoke one in F5 first.",
        outcome.reason === "rate" ? { "retry-after": "3600" } : undefined,
      );
      return;
    }
    deps.onChanged([outcome.clientId]);
    writeJson(response, 201, {
      client_id: outcome.clientId,
      client_id_issued_at: Math.floor(at / 1000),
      client_name: name,
      redirect_uris: redirectUris,
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    });
  };

  const authorize = async (
    request: http.IncomingMessage,
    response: http.ServerResponse,
    config: OAuthServerConfig,
  ) => {
    const url = new URL(request.url ?? "/", "http://placeholder");
    const params = url.searchParams;
    if (!windowOpen()) {
      writeHtml(
        response,
        403,
        "Open F5 first",
        "<p>In F5, open Settings → Integrations → Agent Bridge and choose <b>Connect a client</b>, then try again.</p>",
      );
      return;
    }
    const clientId = params.get("client_id") ?? "";
    const redirectUri = params.get("redirect_uri") ?? "";

    // Until the client and redirect are verified, errors render here, never redirect.
    let client: { name: string; kind: AgentBridgeClientKind; redirectUris: ReadonlyArray<string> };
    let cimd: PendingRequest["cimd"] = null;
    try {
      if (isCimdClientId(clientId, config)) {
        const document = await fetchClientMetadata(clientId);
        client = { name: document.name, kind: "cimd", redirectUris: document.redirectUris };
        cimd = { redirectUris: document.redirectUris };
      } else {
        const record = await run(deps.clients.getClient(clientId));
        if (!record || record.kind !== "dcr") throw new Error("Unknown client.");
        client = { name: record.name, kind: "dcr", redirectUris: record.redirectUris };
      }
    } catch {
      writeHtml(response, 400, "Unknown client", "<p>F5 does not recognize this client.</p>");
      return;
    }
    if (!client.redirectUris.includes(redirectUri)) {
      writeHtml(response, 400, "Invalid redirect", "<p>The redirect URI is not registered.</p>");
      return;
    }

    const state = params.get("state");
    const fail = (error: string, description: string) => {
      response.writeHead(302, {
        location: withIss(
          redirectUri,
          { error, error_description: description, state },
          config.issuer,
        ),
        "cache-control": "no-store",
      });
      response.end();
    };
    if (params.get("response_type") !== "code")
      return fail("unsupported_response_type", "Only response_type=code is supported.");
    const challenge = params.get("code_challenge") ?? "";
    if (params.get("code_challenge_method") !== "S256" || !/^[A-Za-z0-9_-]{43}$/u.test(challenge))
      return fail("invalid_request", "PKCE with S256 is required.");
    if (params.get("resource") !== resourceFor(config.issuer))
      return fail("invalid_target", `resource must be ${resourceFor(config.issuer)}.`);
    const rejected = authorizeLimiter.check("authorize");
    if (rejected) return fail("temporarily_unavailable", "Too many authorization requests.");
    if (pending()) return fail("temporarily_unavailable", "Another connection is waiting in F5.");
    authorizeLimiter.consume("authorize");

    const scopeParam = params.get("scope");
    const requestedScopes =
      scopeParam === null || scopeParam.trim().length === 0
        ? [...AGENT_BRIDGE_SCOPES]
        : [...new Set(scopeParam.split(/\s+/u).filter(isScope))];
    if (requestedScopes.length === 0) return fail("invalid_scope", "No supported scope requested.");

    const requestId = randomBytes(16).toString("base64url");
    const matchCode = Array.from(
      { length: 6 },
      () => MATCH_CODE_ALPHABET[randomInt(MATCH_CODE_ALPHABET.length)],
    ).join("");
    requests.set(requestId, {
      requestId,
      clientId,
      clientName: client.name,
      clientKind: client.kind,
      redirectUri,
      state,
      codeChallenge: challenge,
      resource: resourceFor(config.issuer),
      requestedScopes,
      matchCode,
      createdAt: now(),
      cimd,
      outcome: null,
    });
    deps.onChanged(["pairing"]);
    const statusUrl = `/oauth/authorize/status?request=${encodeURIComponent(requestId)}`;
    writeHtml(
      response,
      200,
      "Approve in F5",
      `<p><b>${escapeHtml(client.name)}</b> wants to connect to F5.</p>
<p>Switch to F5 and check that it shows this code:</p><p class="code">${matchCode}</p>
<p id="status">Waiting for your decision in F5…</p>`,
      `const poll=async()=>{try{const r=await fetch(${JSON.stringify(statusUrl)},{cache:"no-store"});const s=await r.json();
if(s.redirect){location.replace(s.redirect);return}if(s.status==="expired"){document.getElementById("status").textContent="This request expired. Start again from your agent.";return}}catch{}setTimeout(poll,2000)};poll();`,
    );
  };

  const authorizeStatus = (request: http.IncomingMessage, response: http.ServerResponse) => {
    expireStale();
    const url = new URL(request.url ?? "/", "http://placeholder");
    const entry = requests.get(url.searchParams.get("request") ?? "");
    if (!entry) {
      writeJson(response, 200, { status: "expired" });
      return;
    }
    if (entry.outcome === null) writeJson(response, 200, { status: "pending" });
    else if ("redirect" in entry.outcome)
      writeJson(response, 200, { status: "decided", redirect: entry.outcome.redirect });
    else writeJson(response, 200, { status: "expired" });
  };

  const token = async (
    request: http.IncomingMessage,
    response: http.ServerResponse,
    config: OAuthServerConfig,
  ) => {
    const form = await readForm(request);
    if (!form) return oauthError(response, 400, "invalid_request", "Unreadable request.");
    const at = now();
    const grantType = form.grant_type;
    const clientId = form.client_id ?? "";
    if (grantType === "authorization_code") {
      const code = await run(deps.store.consumeCode(form.code ?? "", at));
      if (!code || code.clientId !== clientId || code.redirectUri !== form.redirect_uri)
        return oauthError(response, 400, "invalid_grant", "The code is invalid, expired, or used.");
      const verifier = form.code_verifier ?? "";
      if (
        !/^[A-Za-z0-9._~-]{43,128}$/u.test(verifier) ||
        !safeEqual(s256(verifier), code.codeChallenge)
      )
        return oauthError(response, 400, "invalid_grant", "PKCE verification failed.");
      if (form.resource !== undefined && form.resource !== code.resource)
        return oauthError(response, 400, "invalid_target", "The resource does not match.");
      if (code.resource !== resourceFor(config.issuer))
        return oauthError(
          response,
          400,
          "invalid_grant",
          "The code was issued for another issuer.",
        );
      const client = await run(deps.clients.getClient(clientId));
      if (!client || client.revokedAt !== null)
        return oauthError(response, 400, "invalid_grant", "The client is revoked.");
      const tokens = await run(
        deps.store.issueTokens({
          clientId,
          scopes: code.scopes,
          resource: code.resource,
          grantGeneration: client.grantGeneration,
          at,
        }),
      );
      deps.onChanged([clientId]);
      return writeJson(response, 200, {
        access_token: tokens.accessToken,
        token_type: "Bearer",
        expires_in: tokens.expiresInSeconds,
        refresh_token: tokens.refreshToken,
        scope: tokens.scopes.join(" "),
      });
    }
    if (grantType === "refresh_token") {
      const outcome = await run(
        deps.store.rotateRefresh({
          refreshToken: form.refresh_token ?? "",
          clientId,
          resource: form.resource ?? null,
          at,
          currentGrant: (id) =>
            deps.clients.getClient(id).pipe(
              Effect.map((client) =>
                client && client.revokedAt === null
                  ? { scopes: client.scopes, generation: client.grantGeneration }
                  : null,
              ),
              Effect.mapError((cause) => new OAuthStoreError({ operation: "grant", cause })),
            ),
        }),
      );
      if (outcome.kind === "reused") {
        await deps.onGrantChanged(outcome.clientId, "reused");
        deps.onChanged([outcome.clientId]);
        return oauthError(response, 400, "invalid_grant", "The refresh token was already used.");
      }
      if (outcome.kind === "invalid")
        return oauthError(
          response,
          400,
          "invalid_grant",
          "The refresh token is invalid or expired.",
        );
      deps.onChanged([outcome.clientId]);
      return writeJson(response, 200, {
        access_token: outcome.tokens.accessToken,
        token_type: "Bearer",
        expires_in: outcome.tokens.expiresInSeconds,
        refresh_token: outcome.tokens.refreshToken,
        scope: outcome.tokens.scopes.join(" "),
      });
    }
    return oauthError(response, 400, "unsupported_grant_type", "Unsupported grant_type.");
  };

  return {
    handleRoute: async (request, response, pathname) => {
      const config = deps.config();
      if (!config) return false;
      const method = request.method ?? "GET";
      const route = `${method} ${pathname}`;
      switch (route) {
        case "GET /.well-known/oauth-protected-resource":
        case "GET /.well-known/oauth-protected-resource/mcp":
          metadata(response, config, "resource");
          return true;
        case "GET /.well-known/oauth-authorization-server":
          metadata(response, config, "server");
          return true;
        case "POST /oauth/register":
          await register(request, response, config);
          return true;
        case "GET /oauth/authorize":
          await authorize(request, response, config);
          return true;
        case "GET /oauth/authorize/status":
          authorizeStatus(request, response);
          return true;
        case "POST /oauth/token":
          await token(request, response, config);
          return true;
        default:
          return false;
      }
    },

    authenticate: async (provided) => {
      const config = deps.config();
      if (!config) return null;
      const record = await run(deps.store.findAccessToken(provided, now()));
      if (!record || record.resource !== resourceFor(config.issuer)) return null;
      const client = await run(deps.clients.getClient(record.clientId));
      if (!client || client.revokedAt !== null) return null;
      if (client.grantGeneration !== record.grantGeneration) return null;
      return { client, familyId: record.familyId };
    },

    openPairingWindow: () => {
      windowOpenUntil = now() + AGENT_BRIDGE_PAIRING_WINDOW_MS;
      deps.onChanged(["pairing"]);
    },

    pairingState: () => {
      const entry = pending();
      return {
        openUntil:
          windowOpen() && windowOpenUntil !== null ? new Date(windowOpenUntil).toISOString() : null,
        pending: entry
          ? {
              requestId: entry.requestId,
              clientId: entry.clientId,
              clientName: entry.clientName,
              clientKind: entry.clientKind,
              redirectUri: entry.redirectUri,
              requestedScopes: [...entry.requestedScopes],
              matchCode: entry.matchCode,
              createdAt: new Date(entry.createdAt).toISOString(),
            }
          : null,
      };
    },

    decide: async (input) => {
      const config = deps.config();
      const entry = pending();
      if (!config || !entry || entry.requestId !== input.requestId)
        throw new OAuthDecisionError("That authorization request is no longer waiting.");
      if (!input.approve) {
        entry.outcome = {
          redirect: withIss(
            entry.redirectUri,
            { error: "access_denied", error_description: "Denied in F5.", state: entry.state },
            config.issuer,
          ),
        };
        deps.onChanged(["pairing"]);
        return;
      }
      const approved = new Set(input.scopes);
      const scopes = entry.requestedScopes.filter((scope) => approved.has(scope));
      if (scopes.length === 0) throw new OAuthDecisionError("Choose at least one permission.");
      const at = now();
      if (entry.cimd)
        await run(
          deps.store.upsertCimdClient({
            clientId: entry.clientId,
            name: entry.clientName,
            redirectUris: entry.cimd.redirectUris,
            at,
          }),
        );
      await run(
        deps.store.setGrant({ clientId: entry.clientId, scopes, projectIds: input.projectIds }),
      );
      await deps.onGrantChanged(entry.clientId, "granted");
      const code = await run(
        deps.store.insertCode({
          clientId: entry.clientId,
          redirectUri: entry.redirectUri,
          codeChallenge: entry.codeChallenge,
          resource: entry.resource,
          scopes,
          projectIds: input.projectIds,
          at,
        }),
      );
      entry.outcome = {
        redirect: withIss(entry.redirectUri, { code, state: entry.state }, config.issuer),
      };
      windowOpenUntil = null;
      deps.onChanged(["pairing", entry.clientId]);
    },

    reset: () => {
      requests.clear();
      windowOpenUntil = null;
      cimdCache.clear();
    },
  };
}
