import { createHash } from "node:crypto";
import * as Http from "node:http";
import type { AddressInfo } from "node:net";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { McpProjectServersConfig, McpServerDefinition } from "@t3tools/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { McpHubAuthManager } from "./McpHubAuth.ts";
import { McpHubUpstream } from "./McpHubUpstream.ts";
import {
  bumpMcpOAuthEpoch,
  McpOAuthProvider,
  memoryOAuthStorage,
  mcpOAuthFetch,
  mcpOAuthKey,
} from "./McpOAuth.ts";

/** An authorization server and a protected MCP server on one loopback port. */
async function startFakeServer() {
  const state = {
    validTokens: new Set<string>(),
    issued: 0,
    registrations: 0,
    refreshes: 0,
    verifiers: new Map<string, string>(),
    lastAuthorize: undefined as URL | undefined,
    /** Refresh tokens are single-use; presenting a used one revokes every token (reuse detection). */
    rotate: false,
    validRefresh: new Set<string>(),
    /** Redirect URIs each registered client may use, matched exactly. */
    registeredRedirects: new Map<string, string[]>(),
    /** Held before answering a token request, to model a slow token endpoint. */
    tokenDelay: undefined as Promise<void> | undefined,
    /** Token refreshes that answer 503 before the endpoint recovers. */
    failRefreshes: 0,
    /** Serve protected-resource metadata only at the URL named in the 401 challenge. */
    challengeOnlyMetadata: false,
    /** Requests that reached the authorization endpoints, with their headers. */
    authRequests: [] as Array<{ path: string; headers: Http.IncomingHttpHeaders }>,
  };
  let base = "";
  const json = (response: Http.ServerResponse, status: number, body: unknown) => {
    response.writeHead(status, { "content-type": "application/json" });
    response.end(JSON.stringify(body));
  };
  const readBody = (request: Http.IncomingMessage) =>
    new Promise<string>((resolve) => {
      let data = "";
      request.on("data", (chunk) => (data += chunk));
      request.on("end", () => resolve(data));
    });
  const issue = () => {
    state.issued += 1;
    const accessToken = `at-${state.issued}`;
    state.validTokens.add(accessToken);
    return {
      access_token: accessToken,
      token_type: "Bearer",
      expires_in: 3600,
      refresh_token: (() => {
        const refresh = `rt-${state.issued}`;
        state.validRefresh.add(refresh);
        return refresh;
      })(),
    };
  };
  const metadataPath = () =>
    state.challengeOnlyMetadata ? "/meta/resource" : "/.well-known/oauth-protected-resource";
  const server = Http.createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", base);
    if (url.pathname !== "/mcp")
      state.authRequests.push({ path: url.pathname, headers: request.headers });
    if (url.pathname.startsWith(metadataPath()))
      return json(response, 200, { resource: `${base}/mcp`, authorization_servers: [base] });
    if (url.pathname.startsWith("/.well-known/oauth-protected-resource"))
      return json(response, 404, { error: "not_found" });
    if (url.pathname === "/.well-known/oauth-authorization-server")
      return json(response, 200, {
        issuer: base,
        authorization_endpoint: `${base}/authorize`,
        token_endpoint: `${base}/token`,
        registration_endpoint: `${base}/register`,
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["none"],
      });
    if (url.pathname === "/register" && request.method === "POST") {
      state.registrations += 1;
      const metadata = JSON.parse(await readBody(request)) as Record<string, unknown>;
      const clientId = `dynamic-client${state.registrations > 1 ? `-${state.registrations}` : ""}`;
      state.registeredRedirects.set(clientId, (metadata.redirect_uris as string[]) ?? []);
      return json(response, 201, { ...metadata, client_id: clientId });
    }
    if (url.pathname === "/token" && request.method === "POST") {
      const params = new URLSearchParams(await readBody(request));
      await state.tokenDelay;
      if (params.get("grant_type") === "authorization_code") {
        const challenge = state.verifiers.get(params.get("code") ?? "");
        const verifier = params.get("code_verifier") ?? "";
        const computed = createHash("sha256").update(verifier).digest("base64url");
        if (!challenge || challenge !== computed)
          return json(response, 400, { error: "invalid_grant" });
        return json(response, 200, issue());
      }
      if (params.get("grant_type") === "refresh_token") {
        state.refreshes += 1;
        if (state.failRefreshes > 0) {
          state.failRefreshes -= 1;
          return json(response, 503, { error: "temporarily_unavailable" });
        }
        const presented = params.get("refresh_token") ?? "";
        if (state.rotate) {
          if (!state.validRefresh.has(presented)) {
            state.validRefresh.clear();
            state.validTokens.clear();
            return json(response, 400, { error: "invalid_grant" });
          }
          state.validRefresh.delete(presented);
        }
        return json(response, 200, issue());
      }
      return json(response, 400, { error: "unsupported_grant_type" });
    }
    if (url.pathname === "/mcp") {
      const token = (request.headers.authorization ?? "").replace(/^Bearer /u, "");
      if (!state.validTokens.has(token)) {
        response.writeHead(401, {
          "www-authenticate": `Bearer resource_metadata="${base}${metadataPath()}"`,
        });
        return response.end();
      }
      const mcp = new McpServer({ name: "protected", version: "1.0.0" });
      mcp.registerTool("whoami", { description: "Who is signed in" }, () => ({
        content: [{ type: "text", text: token }],
      }));
      const transport = new StreamableHTTPServerTransport({ enableJsonResponse: true });
      await mcp.connect(transport as Transport);
      const body = request.method === "POST" ? JSON.parse(await readBody(request)) : undefined;
      await transport.handleRequest(request, response, body);
      return;
    }
    response.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    state,
    base,
    /** Plays the browser: approves the authorization request and returns the redirect. */
    approve: (authorizationUrl: string) => {
      const url = new URL(authorizationUrl);
      const registered = state.registeredRedirects.get(url.searchParams.get("client_id") ?? "");
      if (registered && !registered.includes(url.searchParams.get("redirect_uri") ?? ""))
        throw new Error("redirect_uri does not match the registration");
      const code = `code-${state.verifiers.size + 1}`;
      state.verifiers.set(code, url.searchParams.get("code_challenge") ?? "");
      state.lastAuthorize = url;
      const redirect = new URL(url.searchParams.get("redirect_uri")!);
      redirect.searchParams.set("code", code);
      redirect.searchParams.set("state", url.searchParams.get("state") ?? "");
      return redirect.toString();
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

type FakeServer = Awaited<ReturnType<typeof startFakeServer>>;

describe("MCP hub sign-in", () => {
  let fake: FakeServer;
  let storage: ReturnType<typeof memoryOAuthStorage>;
  let upstream: McpHubUpstream;
  let manager: McpHubAuthManager;
  let definition: McpServerDefinition;
  const reconnected: string[] = [];

  beforeEach(async () => {
    fake = await startFakeServer();
    storage = memoryOAuthStorage();
    definition = { type: "http", url: `${fake.base}/mcp` };
    upstream = new McpHubUpstream({
      name: "protected",
      definition,
      scope: "shared",
      environment: {},
      cwd: process.cwd(),
      authProvider: new McpOAuthProvider({ storage, serverUrl: definition.url, definition }),
    });
    manager = new McpHubAuthManager({
      storage,
      hub: {
        reconnectOAuth: async (key) => {
          reconnected.push(key);
          await upstream.reconnect();
          return 1;
        },
      },
      readServers: async () => ({ protected: definition }) as McpProjectServersConfig,
      environment: {},
    });
  });

  afterEach(async () => {
    manager.close();
    await upstream.stop();
    await fake.close();
    reconnected.length = 0;
  });

  it("reports needs-auth, signs in through the loopback callback, and reconnects", async () => {
    await expect(upstream.listTools()).rejects.toThrow();
    expect(upstream.snapshot().state).toBe("needs-auth");
    // Background connections never register a client.
    expect(fake.state.registrations).toBe(0);

    const started = await manager.startSignIn("protected");
    expect(started.status).toBe("pending");
    if (started.status !== "pending") return;
    const authorize = new URL(started.attempt.authorizationUrl);
    expect(authorize.searchParams.get("client_id")).toBe("dynamic-client");
    expect(authorize.searchParams.get("code_challenge_method")).toBe("S256");
    expect(started.attempt.redirectUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/u);
    expect((await manager.status()).servers[0]).toMatchObject({
      name: "protected",
      signedIn: false,
      pending: { attemptId: started.attempt.attemptId },
    });

    const page = await fetch(fake.approve(started.attempt.authorizationUrl));
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("Signed in to protected");
    expect(reconnected).toEqual([mcpOAuthKey(`${fake.base}/mcp`, undefined)]);

    const tools = await upstream.listTools();
    expect(tools.map((tool) => tool.name)).toEqual(["whoami"]);
    const status = (await manager.status()).servers[0]!;
    expect(status).toMatchObject({ signedIn: true, refreshable: true });
    expect(status.pending).toBeUndefined();
    expect(status.expiresAt).toBeDefined();
    // The callback listener closes with the attempt.
    await expect(fetch(started.attempt.redirectUrl)).rejects.toThrow();
  });

  it("completes from a pasted redirect and refuses another attempt's state", async () => {
    const started = await manager.startSignIn("protected");
    if (started.status !== "pending") throw new Error("expected a pending attempt");
    const redirected = new URL(fake.approve(started.attempt.authorizationUrl));
    const forged = new URL(redirected);
    forged.searchParams.set("state", "someone-else");
    await expect(
      manager.completeSignIn(started.attempt.attemptId, forged.toString()),
    ).rejects.toThrow(/different sign-in attempt/);
    // A remote browser lands on a page that does not load; the user pastes its address.
    const done = await manager.completeSignIn(started.attempt.attemptId, redirected.toString());
    expect(done).toEqual({ status: "signed-in", serverName: "protected", reconnected: 1 });
    await expect(
      manager.completeSignIn(started.attempt.attemptId, redirected.toString()),
    ).rejects.toThrow(/has ended/);
  });

  it("reports a refused authorization and ends the attempt", async () => {
    const started = await manager.startSignIn("protected");
    if (started.status !== "pending") throw new Error("expected a pending attempt");
    const state = new URL(started.attempt.authorizationUrl).searchParams.get("state")!;
    const refused = `${started.attempt.redirectUrl}?error=access_denied&error_description=No&state=${state}`;
    await expect(manager.completeSignIn(started.attempt.attemptId, refused)).rejects.toThrow(
      "The server refused sign-in: access_denied (No).",
    );
    expect((await manager.status()).servers[0]!.pending).toBeUndefined();
  });

  it("refreshes an expired access token without a new sign-in, and signs out", async () => {
    const started = await manager.startSignIn("protected");
    if (started.status !== "pending") throw new Error("expected a pending attempt");
    await manager.completeSignIn(
      started.attempt.attemptId,
      fake.approve(started.attempt.authorizationUrl),
    );
    await upstream.listTools();
    // The server forgets the access token; the stored refresh token renews it.
    fake.state.validTokens.clear();
    await upstream.reconnect();
    expect((await upstream.listTools()).map((tool) => tool.name)).toEqual(["whoami"]);
    expect(fake.state.refreshes).toBe(1);
    expect(fake.state.registrations).toBe(1);

    expect(await manager.signOut("protected")).toEqual({ signedOut: true });
    expect((await manager.status()).servers[0]).toMatchObject({ signedIn: false });
    // The registration survives sign-out, so the next sign-in skips it.
    const again = await manager.startSignIn("protected");
    expect(again.status).toBe("pending");
    expect(fake.state.registrations).toBe(1);
    expect(await manager.signOut("protected")).toEqual({ signedOut: false });
  });

  it("refuses servers that cannot sign in", async () => {
    const local = new McpHubAuthManager({
      storage,
      hub: undefined,
      readServers: async () =>
        ({
          local: { type: "stdio", command: "node" },
          templated: { type: "http", url: "https://${env:UNSET_OAUTH_HOST}/mcp" },
        }) as unknown as McpProjectServersConfig,
      environment: {},
    });
    await expect(local.startSignIn("local")).rejects.toThrow(/runs locally/);
    await expect(local.startSignIn("missing")).rejects.toThrow(/not configured/);
    await expect(local.startSignIn("templated")).rejects.toThrow(/UNSET_OAUTH_HOST/);
  });

  async function signIn() {
    const started = await manager.startSignIn("protected");
    if (started.status !== "pending") throw new Error("expected a pending attempt");
    await manager.completeSignIn(
      started.attempt.attemptId,
      fake.approve(started.attempt.authorizationUrl),
    );
    return started.attempt;
  }

  it("leaves servers with their own Authorization out of sign-in", async () => {
    const staticAuth = new McpHubAuthManager({
      storage,
      hub: undefined,
      readServers: async () =>
        ({
          keyed: { type: "http", url: `${fake.base}/mcp`, headers: { Authorization: "Bearer k" } },
          variable: { type: "http", url: `${fake.base}/mcp`, bearerTokenEnvVar: "DOCS_TOKEN" },
        }) as McpProjectServersConfig,
      environment: { DOCS_TOKEN: "secret" },
    });
    expect((await staticAuth.status()).servers).toEqual([]);
    await expect(staticAuth.startSignIn("keyed")).rejects.toThrow(/configured Authorization/);
    expect(fake.state.authRequests).toEqual([]);
  });

  it("refreshes once when several connections find the token expired together", async () => {
    fake.state.rotate = true;
    await signIn();
    const other = new McpHubUpstream({
      name: "protected",
      definition,
      scope: "session",
      environment: {},
      cwd: process.cwd(),
      authProvider: new McpOAuthProvider({ storage, serverUrl: definition.url!, definition }),
    });
    try {
      await Promise.all([upstream.listTools(), other.listTools()]);
      fake.state.validTokens.clear();
      await Promise.all([upstream.reconnect(), other.reconnect()]);
      await Promise.all([upstream.listTools(), other.listTools()]);
      expect(fake.state.refreshes).toBe(1);
      expect(upstream.snapshot().state).toBe("ready");
      expect(other.snapshot().state).toBe("ready");
      expect((await manager.status()).servers[0]).toMatchObject({ signedIn: true });
    } finally {
      await other.stop();
    }
  });

  it("keeps tokens another connection rotated when its own refresh is rejected", async () => {
    await signIn();
    const key = mcpOAuthKey(definition.url!, undefined);
    const stale = new McpOAuthProvider({ storage, serverUrl: definition.url!, definition });
    const read = await stale.tokens();
    const fresh = { ...read!, access_token: "at-new", refresh_token: "rt-new" };
    await storage.write(key, { ...storage.records.get(key)!, tokens: fresh });
    await stale.invalidateCredentials("tokens");
    expect(storage.records.get(key)?.tokens?.refresh_token).toBe("rt-new");
    // The same rejection for the token that is still stored does sign out.
    const current = new McpOAuthProvider({ storage, serverUrl: definition.url!, definition });
    await current.tokens();
    await current.invalidateCredentials("tokens");
    expect(storage.records.get(key)?.tokens).toBeUndefined();
  });

  it("retries instead of asking to sign in when a refresh fails for a moment", async () => {
    await signIn();
    upstream.retain();
    await upstream.listTools();
    fake.state.validTokens.clear();
    fake.state.failRefreshes = 1;
    await upstream.reconnect();
    expect(upstream.snapshot().state).toBe("retrying");
    await expect.poll(() => upstream.snapshot().state, { timeout: 5_000 }).toBe("ready");
    expect((await upstream.listTools()).map((tool) => tool.name)).toEqual(["whoami"]);
  });

  it("does not let a code exchange that finishes after sign-out sign the user back in", async () => {
    const started = await manager.startSignIn("protected");
    if (started.status !== "pending") throw new Error("expected a pending attempt");
    let release!: () => void;
    fake.state.tokenDelay = new Promise((resolve) => (release = resolve));
    const completing = manager.completeSignIn(
      started.attempt.attemptId,
      fake.approve(started.attempt.authorizationUrl),
    );
    await expect.poll(() => fake.state.authRequests.some((r) => r.path === "/token")).toBe(true);
    await manager.signOut("protected");
    release();
    await expect(completing).rejects.toThrow(/cancelled/);
    expect((await manager.status()).servers[0]).toMatchObject({ signedIn: false });
  });

  it("rejects token writes that started before a sign-out", async () => {
    await signIn();
    const key = mcpOAuthKey(definition.url!, undefined);
    const refreshing = new McpOAuthProvider({ storage, serverUrl: definition.url!, definition });
    const tokens = await refreshing.tokens();
    bumpMcpOAuthEpoch(key);
    await expect(refreshing.saveTokens({ ...tokens!, access_token: "late" })).rejects.toThrow(
      /Signed out/,
    );
    expect(storage.records.get(key)?.tokens?.access_token).not.toBe("late");
  });

  it("registers again when the stored registration's redirect port is taken", async () => {
    const first = await signIn();
    const port = Number(new URL(first.redirectUrl).port);
    const blocker = Http.createServer();
    await new Promise<void>((resolve) => blocker.listen(port, "127.0.0.1", resolve));
    try {
      await manager.signOut("protected");
      const second = await manager.startSignIn("protected");
      if (second.status !== "pending") throw new Error("expected a pending attempt");
      expect(second.attempt.redirectUrl).not.toBe(first.redirectUrl);
      expect(fake.state.registrations).toBe(2);
      // The exact-match server accepts the new redirect.
      const page = await fetch(fake.approve(second.attempt.authorizationUrl));
      expect(page.status).toBe(200);
    } finally {
      await new Promise((resolve) => blocker.close(resolve));
    }
  });

  it("uses the metadata URL from the server's challenge", async () => {
    fake.state.challengeOnlyMetadata = true;
    await signIn();
    expect(fake.state.authRequests.map((r) => r.path)).toContain("/meta/resource");
    expect((await manager.status()).servers[0]).toMatchObject({ signedIn: true });
  });

  it("answers a malformed callback request without failing", async () => {
    const started = await manager.startSignIn("protected");
    if (started.status !== "pending") throw new Error("expected a pending attempt");
    const { port } = new URL(started.attempt.redirectUrl);
    const status = await new Promise<number | undefined>((resolve, reject) => {
      const request = Http.request({ host: "127.0.0.1", port, path: "//[" }, (response) => {
        response.resume();
        resolve(response.statusCode);
      });
      request.on("error", reject);
      request.end();
    });
    expect(status).toBe(400);
    const other = await fetch(`http://127.0.0.1:${port}/elsewhere?state=x`);
    expect(other.status).toBe(404);
  });
});

describe("mcpOAuthFetch", () => {
  it("keeps the server's own headers on its origin", async () => {
    const seen: Array<{ url: string; headers: Headers }> = [];
    const base = async (url: string | URL, init?: RequestInit) => {
      seen.push({ url: url.toString(), headers: new Headers(init?.headers) });
      return new Response("{}");
    };
    const fetchFn = mcpOAuthFetch("https://mcp.example.test/mcp", ["X-Tenant"], base);
    const headers = { "x-tenant": "acme", accept: "application/json" };
    await fetchFn("https://mcp.example.test/.well-known/oauth-protected-resource", { headers });
    await fetchFn("https://auth.example.test/token", { headers });
    expect(seen[0]!.headers.get("x-tenant")).toBe("acme");
    expect(seen[1]!.headers.get("x-tenant")).toBeNull();
    expect(seen[1]!.headers.get("accept")).toBe("application/json");
  });

  it("shares one refresh request per refresh token and retries a failed one", async () => {
    let calls = 0;
    let status = 200;
    const base = async () => {
      calls += 1;
      await new Promise((resolve) => setTimeout(resolve, 10));
      return new Response(JSON.stringify({ access_token: `at-${calls}` }), { status });
    };
    const fetchFn = mcpOAuthFetch("https://mcp.example.test/mcp", [], base);
    const refresh = (token: string) =>
      fetchFn("https://auth.example.test/token", {
        method: "POST",
        body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: token }),
      }).then((response) => response.json());
    const [a, b] = await Promise.all([refresh("rt-shared"), refresh("rt-shared")]);
    expect(a).toEqual(b);
    expect(calls).toBe(1);
    status = 503;
    await refresh("rt-failing");
    await refresh("rt-failing");
    expect(calls).toBe(3);
  });
});
