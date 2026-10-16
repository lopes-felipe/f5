import { createHash, randomBytes } from "node:crypto";
import http from "node:http";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { AGENT_BRIDGE_CHATGPT_REDIRECT_URI } from "@t3tools/contracts";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { startMcpListener, type McpListener } from "./AgentBridgeListeners.ts";
import { makeAgentBridgeStore } from "./AgentBridgeStore.ts";
import { makeOAuthServer, protectedResourceMetadataUrl } from "./oauthServer.ts";
import { ACCESS_TOKEN_TTL_MS, makeOAuthStore } from "./OAuthStore.ts";
import type { OutboundHttps } from "./outboundHttps.ts";
import { makeThreadTools } from "./threadTools.ts";
import { makeAgentBridgeLimiters } from "./rateLimits.ts";
import { FakeAgentBridgeHost, project } from "./testing/fakeHost.ts";

const ISSUER = "https://f5.example.com";
const RESOURCE = `${ISSUER}/mcp`;
const CIMD_ID = "https://chatgpt.com/oauth/client-metadata.json";

const layer = it.layer(SqlitePersistenceMemory.pipe(Layer.provideMerge(NodeServices.layer)));

const pkce = () => {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
};

const setup = () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const clients = makeAgentBridgeStore(sql);
    const store = makeOAuthStore(sql);
    let clock = Date.parse("2026-10-15T12:00:00.000Z");
    const grantEvents: Array<{ clientId: string; reason: string }> = [];
    const outbound: OutboundHttps = async (request) => {
      if (request.url !== CIMD_ID) throw new Error("unexpected fetch");
      return {
        status: 200,
        headers: {},
        body: JSON.stringify({
          client_id: CIMD_ID,
          client_name: "ChatGPT",
          redirect_uris: [AGENT_BRIDGE_CHATGPT_REDIRECT_URI],
        }),
      };
    };
    const oauth = makeOAuthServer({
      store,
      clients,
      outbound,
      config: () => ({
        issuer: ISSUER,
        allowedRedirectUris: [AGENT_BRIDGE_CHATGPT_REDIRECT_URI],
        trustedClientMetadataHosts: ["chatgpt.com"],
      }),
      onChanged: () => undefined,
      onGrantChanged: async (clientId, reason) => {
        grantEvents.push({ clientId, reason });
      },
      now: () => clock,
    });
    const host = new FakeAgentBridgeHost();
    host.projects = [project("exposed")];
    const tools = makeThreadTools({
      host: host.shape,
      store: clients,
      limiters: makeAgentBridgeLimiters(),
    });
    const localToken = "local-token-never-accepted-remotely";
    const listener: McpListener = yield* Effect.acquireRelease(
      Effect.promise(() =>
        startMcpListener({
          authenticate: async (token) => {
            const authenticated = await oauth.authenticate(token);
            return authenticated
              ? { client: authenticated.client, visibleProjectIds: new Set(["exposed"]) }
              : null;
          },
          tools: () => tools,
          serverVersion: "test",
          unauthorizedHeaders: {
            "www-authenticate": `Bearer resource_metadata="${protectedResourceMetadataUrl(ISSUER)}"`,
          },
          allowedHosts: () => ["f5.example.com"],
          routes: oauth.handleRoute,
        }),
      ),
      (opened) => Effect.promise(() => opened.close()),
    );
    const base = `http://127.0.0.1:${listener.port}`;
    const get = (path: string, headers: Record<string, string> = {}) =>
      Effect.promise(() => fetch(`${base}${path}`, { headers, redirect: "manual" }));
    const post = (
      path: string,
      body: unknown,
      form = false,
      headers: Record<string, string> = {},
    ) =>
      Effect.promise(() =>
        fetch(`${base}${path}`, {
          method: "POST",
          headers: {
            "content-type": form ? "application/x-www-form-urlencoded" : "application/json",
            ...headers,
          },
          body: form
            ? new URLSearchParams(body as Record<string, string>).toString()
            : JSON.stringify(body),
        }),
      );
    const json = (response: Response) => Effect.promise(() => response.json() as Promise<any>);
    const register = (redirectUris = [AGENT_BRIDGE_CHATGPT_REDIRECT_URI]) =>
      post("/oauth/register", { client_name: "Test Dot", redirect_uris: redirectUris }).pipe(
        Effect.flatMap(json),
      );
    const authorizeUrl = (input: {
      clientId: string;
      challenge: string;
      state?: string;
      scope?: string;
      resource?: string;
    }) =>
      `/oauth/authorize?${new URLSearchParams({
        response_type: "code",
        client_id: input.clientId,
        redirect_uri: AGENT_BRIDGE_CHATGPT_REDIRECT_URI,
        code_challenge: input.challenge,
        code_challenge_method: "S256",
        resource: input.resource ?? RESOURCE,
        state: input.state ?? "state-1",
        ...(input.scope ? { scope: input.scope } : {}),
      }).toString()}`;
    /** Runs authorize → approve → token and returns the token response. */
    const connect = (clientId: string, scopes = ["f5.read", "f5.tasks"] as const) =>
      Effect.gen(function* () {
        const { verifier, challenge } = pkce();
        oauth.openPairingWindow();
        const page = yield* get(authorizeUrl({ clientId, challenge, scope: "f5.read f5.tasks" }));
        assert.strictEqual(page.status, 200);
        const pending = oauth.pairingState().pending!;
        yield* Effect.promise(() =>
          oauth.decide({
            requestId: pending.requestId,
            approve: true,
            scopes: [...scopes],
            projectIds: ["exposed"],
          }),
        );
        const status = yield* get(`/oauth/authorize/status?request=${pending.requestId}`).pipe(
          Effect.flatMap(json),
        );
        const redirect = new URL(status.redirect);
        const tokens = yield* post(
          "/oauth/token",
          {
            grant_type: "authorization_code",
            code: redirect.searchParams.get("code")!,
            redirect_uri: AGENT_BRIDGE_CHATGPT_REDIRECT_URI,
            client_id: clientId,
            code_verifier: verifier,
            resource: RESOURCE,
          },
          true,
        ).pipe(Effect.flatMap(json));
        return { tokens, redirect, pending, code: redirect.searchParams.get("code")!, verifier };
      });
    const mcp = (token: string, method: string, params?: unknown) =>
      post("/mcp", { jsonrpc: "2.0", id: 1, method, params }, false, {
        authorization: `Bearer ${token}`,
        "mcp-protocol-version": "2025-06-18",
      });
    return {
      sql,
      clients,
      store,
      oauth,
      grantEvents,
      get,
      post,
      json,
      register,
      authorizeUrl,
      connect,
      mcp,
      localToken,
      port: listener.port,
      advance: (ms: number) => {
        clock += ms;
      },
    };
  });

layer("Agent Bridge OAuth server", (it) => {
  it.effect("publishes metadata from the configured issuer, never from request headers", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { get, json, port } = yield* setup();
        const server = yield* get("/.well-known/oauth-authorization-server").pipe(
          Effect.flatMap(json),
        );
        assert.strictEqual(server.issuer, ISSUER);
        assert.strictEqual(server.token_endpoint, `${ISSUER}/oauth/token`);
        assert.deepStrictEqual(server.code_challenge_methods_supported, ["S256"]);
        assert.deepStrictEqual(server.token_endpoint_auth_methods_supported, ["none"]);
        assert.isTrue(server.client_id_metadata_document_supported);
        assert.isTrue(server.authorization_response_iss_parameter_supported);
        const resource = yield* get("/.well-known/oauth-protected-resource").pipe(
          Effect.flatMap(json),
        );
        assert.strictEqual(resource.resource, RESOURCE);
        assert.deepStrictEqual(resource.authorization_servers, [ISSUER]);
        // fetch() cannot set Host; use http.request for a forged one.
        const statusWithHost = (hostHeader: string) =>
          Effect.promise(
            () =>
              new Promise<number>((resolve, reject) => {
                const request = http.request(
                  {
                    host: "127.0.0.1",
                    port,
                    path: "/.well-known/oauth-authorization-server",
                    headers: { host: hostHeader },
                  },
                  (response) => {
                    response.resume();
                    resolve(response.statusCode ?? 0);
                  },
                );
                request.on("error", reject);
                request.end();
              }),
          );
        assert.strictEqual(yield* statusWithHost("evil.example"), 403);
        assert.strictEqual(yield* statusWithHost("f5.example.com"), 200);
      }),
    ),
  );

  it.effect("a missing token gets 401 with the resource metadata", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { mcp, localToken } = yield* setup();
        const response = yield* mcp(localToken, "tools/list");
        assert.strictEqual(response.status, 401);
        assert.strictEqual(
          response.headers.get("www-authenticate"),
          `Bearer resource_metadata="${ISSUER}/.well-known/oauth-protected-resource"`,
        );
      }),
    ),
  );

  it.effect("DCR accepts only allowlisted redirect URIs", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { register, post } = yield* setup();
        const bad = yield* post("/oauth/register", {
          client_name: "x",
          redirect_uris: ["https://evil.example/cb"],
        });
        assert.strictEqual(bad.status, 400);
        const good = yield* register();
        assert.match(good.client_id, /^dcr_/u);
        assert.strictEqual(good.token_endpoint_auth_method, "none");
      }),
    ),
  );

  it.effect("authorize outside the pairing window shows 'Open F5 first' and creates nothing", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { register, get, authorizeUrl, oauth } = yield* setup();
        const client = yield* register();
        const page = yield* get(
          authorizeUrl({ clientId: client.client_id, challenge: pkce().challenge }),
        );
        assert.strictEqual(page.status, 403);
        assert.include(yield* Effect.promise(() => page.text()), "Open F5 first");
        assert.isNull(oauth.pairingState().pending);
      }),
    ),
  );

  it.effect("authorize errors after client validation redirect with state and iss", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { register, get, authorizeUrl, oauth } = yield* setup();
        const client = yield* register();
        oauth.openPairingWindow();
        const wrongResource = yield* get(
          authorizeUrl({
            clientId: client.client_id,
            challenge: pkce().challenge,
            resource: "https://other.example/mcp",
          }),
        );
        assert.strictEqual(wrongResource.status, 302);
        const location = new URL(wrongResource.headers.get("location")!);
        assert.strictEqual(location.searchParams.get("error"), "invalid_target");
        assert.strictEqual(location.searchParams.get("state"), "state-1");
        assert.strictEqual(location.searchParams.get("iss"), ISSUER);
        const noPkce = yield* get(authorizeUrl({ clientId: client.client_id, challenge: "short" }));
        assert.strictEqual(
          new URL(noPkce.headers.get("location")!).searchParams.get("error"),
          "invalid_request",
        );
        const unknown = yield* get(
          authorizeUrl({ clientId: "dcr_unknown", challenge: pkce().challenge }),
        );
        assert.strictEqual(unknown.status, 400);
      }),
    ),
  );

  it.effect("full flow: one pending request, match code, decision, PKCE, scoped tools", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { register, connect, get, authorizeUrl, mcp, json, post, clients } = yield* setup();
        const client = yield* register();
        const { tokens, redirect, pending, code, verifier } = yield* connect(client.client_id);
        assert.match(pending.matchCode, /^[A-Z2-9]{6}$/u);
        assert.deepStrictEqual(pending.requestedScopes, ["f5.read", "f5.tasks"]);
        assert.strictEqual(redirect.searchParams.get("state"), "state-1");
        assert.strictEqual(redirect.searchParams.get("iss"), ISSUER);
        assert.strictEqual(tokens.token_type, "Bearer");
        assert.strictEqual(tokens.expires_in, ACCESS_TOKEN_TTL_MS / 1000);
        assert.strictEqual(tokens.scope, "f5.read f5.tasks");
        const record = yield* clients.getClient(client.client_id);
        assert.deepStrictEqual(record?.projectIds, ["exposed"]);

        // The code is single-use.
        const replay = yield* post(
          "/oauth/token",
          {
            grant_type: "authorization_code",
            code,
            redirect_uri: AGENT_BRIDGE_CHATGPT_REDIRECT_URI,
            client_id: client.client_id,
            code_verifier: verifier,
          },
          true,
        ).pipe(Effect.flatMap(json));
        assert.strictEqual(replay.error, "invalid_grant");

        const listed = yield* mcp(tokens.access_token, "tools/list").pipe(Effect.flatMap(json));
        const names = listed.result.tools.map((tool: { name: string }) => tool.name);
        assert.include(names, "list_projects");
        assert.notInclude(names, "create_thread");

        // The window closed with the decision.
        const late = yield* get(
          authorizeUrl({ clientId: client.client_id, challenge: pkce().challenge }),
        );
        assert.strictEqual(late.status, 403);
      }),
    ),
  );

  it.effect("a wrong PKCE verifier fails", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { register, get, authorizeUrl, oauth, post, json } = yield* setup();
        const client = yield* register();
        oauth.openPairingWindow();
        yield* get(authorizeUrl({ clientId: client.client_id, challenge: pkce().challenge }));
        const pending = oauth.pairingState().pending!;
        yield* Effect.promise(() =>
          oauth.decide({
            requestId: pending.requestId,
            approve: true,
            scopes: ["f5.read"],
            projectIds: [],
          }),
        );
        const status = yield* get(`/oauth/authorize/status?request=${pending.requestId}`).pipe(
          Effect.flatMap(json),
        );
        const response = yield* post(
          "/oauth/token",
          {
            grant_type: "authorization_code",
            code: new URL(status.redirect).searchParams.get("code")!,
            redirect_uri: AGENT_BRIDGE_CHATGPT_REDIRECT_URI,
            client_id: client.client_id,
            code_verifier: pkce().verifier,
          },
          true,
        ).pipe(Effect.flatMap(json));
        assert.strictEqual(response.error, "invalid_grant");
      }),
    ),
  );

  it.effect(
    "a second authorize while one is pending is refused; deny redirects access_denied",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { register, get, authorizeUrl, oauth, json } = yield* setup();
          const client = yield* register();
          oauth.openPairingWindow();
          yield* get(authorizeUrl({ clientId: client.client_id, challenge: pkce().challenge }));
          const second = yield* get(
            authorizeUrl({ clientId: client.client_id, challenge: pkce().challenge, state: "s2" }),
          );
          assert.strictEqual(
            new URL(second.headers.get("location")!).searchParams.get("error"),
            "temporarily_unavailable",
          );
          const pending = oauth.pairingState().pending!;
          yield* Effect.promise(() =>
            oauth.decide({
              requestId: pending.requestId,
              approve: false,
              scopes: [],
              projectIds: [],
            }),
          );
          const status = yield* get(`/oauth/authorize/status?request=${pending.requestId}`).pipe(
            Effect.flatMap(json),
          );
          const redirect = new URL(status.redirect);
          assert.strictEqual(redirect.searchParams.get("error"), "access_denied");
          assert.strictEqual(redirect.searchParams.get("iss"), ISSUER);
        }),
      ),
  );

  it.effect("refresh rotates; reusing a rotated refresh token revokes the family and fences", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { register, connect, post, json, mcp, grantEvents, clients } = yield* setup();
        const client = yield* register();
        const { tokens } = yield* connect(client.client_id);
        const refresh = (token: string) =>
          post(
            "/oauth/token",
            { grant_type: "refresh_token", refresh_token: token, client_id: client.client_id },
            true,
          ).pipe(Effect.flatMap(json));
        const rotated = yield* refresh(tokens.refresh_token);
        assert.isString(rotated.access_token);
        assert.notStrictEqual(rotated.refresh_token, tokens.refresh_token);
        const before = (yield* clients.getClient(client.client_id))!.grantGeneration;

        const reused = yield* refresh(tokens.refresh_token);
        assert.strictEqual(reused.error, "invalid_grant");
        assert.deepStrictEqual(grantEvents.at(-1), {
          clientId: client.client_id,
          reason: "reused",
        });
        assert.strictEqual(
          (yield* clients.getClient(client.client_id))!.grantGeneration,
          before + 1,
        );
        // The whole family is gone: the rotated tokens no longer work.
        assert.strictEqual((yield* mcp(rotated.access_token, "tools/list")).status, 401);
        assert.strictEqual((yield* refresh(rotated.refresh_token)).error, "invalid_grant");
      }),
    ),
  );

  it.effect("access tokens expire and stop working after a grant change", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { register, connect, mcp, advance, store } = yield* setup();
        const client = yield* register();
        const first = yield* connect(client.client_id);
        assert.strictEqual((yield* mcp(first.tokens.access_token, "tools/list")).status, 200);
        yield* store.setGrant({ clientId: client.client_id, scopes: ["f5.read"], projectIds: [] });
        assert.strictEqual((yield* mcp(first.tokens.access_token, "tools/list")).status, 401);

        const second = yield* connect(client.client_id);
        advance(ACCESS_TOKEN_TTL_MS + 1);
        assert.strictEqual((yield* mcp(second.tokens.access_token, "tools/list")).status, 401);
      }),
    ),
  );

  it.effect("a client metadata document client is fetched and stored on approval", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { connect, clients, mcp } = yield* setup();
        const { tokens, pending } = yield* connect(CIMD_ID);
        assert.strictEqual(pending.clientKind, "cimd");
        assert.strictEqual(pending.clientName, "ChatGPT");
        const record = yield* clients.getClient(CIMD_ID);
        assert.strictEqual(record?.kind, "cimd");
        assert.deepStrictEqual(record?.redirectUris, [AGENT_BRIDGE_CHATGPT_REDIRECT_URI]);
        assert.strictEqual((yield* mcp(tokens.access_token, "tools/list")).status, 200);
      }),
    ),
  );

  it.effect("revocation deletes tokens", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { register, connect, mcp, store } = yield* setup();
        const client = yield* register();
        const { tokens } = yield* connect(client.client_id);
        yield* store.revokeClient(client.client_id, Date.now());
        assert.strictEqual((yield* mcp(tokens.access_token, "tools/list")).status, 401);
      }),
    ),
  );
});
