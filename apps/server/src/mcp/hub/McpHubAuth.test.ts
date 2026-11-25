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
import { McpOAuthProvider, memoryOAuthStorage, mcpOAuthKey } from "./McpOAuth.ts";

/** An authorization server and a protected MCP server on one loopback port. */
async function startFakeServer() {
  const state = {
    validTokens: new Set<string>(),
    issued: 0,
    registrations: 0,
    refreshes: 0,
    verifiers: new Map<string, string>(),
    lastAuthorize: undefined as URL | undefined,
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
      refresh_token: `rt-${state.issued}`,
    };
  };
  const server = Http.createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", base);
    if (url.pathname.startsWith("/.well-known/oauth-protected-resource"))
      return json(response, 200, { resource: `${base}/mcp`, authorization_servers: [base] });
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
      return json(response, 201, { ...metadata, client_id: "dynamic-client" });
    }
    if (url.pathname === "/token" && request.method === "POST") {
      const params = new URLSearchParams(await readBody(request));
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
        return json(response, 200, issue());
      }
      return json(response, 400, { error: "unsupported_grant_type" });
    }
    if (url.pathname === "/mcp") {
      const token = (request.headers.authorization ?? "").replace(/^Bearer /u, "");
      if (!state.validTokens.has(token)) {
        response.writeHead(401, {
          "www-authenticate": `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource"`,
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
});
