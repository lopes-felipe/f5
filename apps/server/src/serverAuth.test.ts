import * as Http from "node:http";

import { afterEach, describe, expect, it } from "vitest";

import { makeServerAuth, makeTrustedProxyCheck, requestUsesTls } from "./serverAuth.ts";

const servers: Http.Server[] = [];

async function startAuthServer(auth: ReturnType<typeof makeServerAuth>): Promise<string> {
  const server = Http.createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    void auth.handleHttpRequest(request, response, url).then((handled) => {
      if (handled) return;
      response.writeHead(auth.isHttpRequestAuthenticated(request) ? 200 : 401);
      response.end();
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Auth test server did not bind.");
  return `http://127.0.0.1:${address.port}`;
}

afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map(
        (server) =>
          new Promise<void>((resolve, reject) =>
            server.close((error) => (error ? reject(error) : resolve())),
          ),
      ),
  );
});

describe("server authentication", () => {
  it("rate limits repeated failures and recovers after the lockout", async () => {
    let now = 1_000;
    const auth = makeServerAuth("correct-token", {
      now: () => now,
      maxFailuresPerSource: 2,
      maxFailuresGlobal: 100,
      failureWindowMs: 60_000,
      lockoutMs: 10_000,
    });
    const origin = await startAuthServer(auth);
    const authenticate = (token: string) =>
      fetch(`${origin}/auth/session`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token }),
      });

    expect((await authenticate("wrong-once")).status).toBe(401);
    const limited = await authenticate("wrong-twice");
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("10");
    expect((await authenticate("correct-token")).status).toBe(429);

    now += 10_001;
    expect((await authenticate("correct-token")).status).toBe(204);
    expect((await authenticate("wrong-after-recovery")).status).toBe(401);
  });

  it("marks proxy-terminated HTTPS sessions Secure and accepts bearer credentials", async () => {
    const auth = makeServerAuth("correct-token");
    const origin = await startAuthServer(auth);
    const session = await fetch(`${origin}/auth/session`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Forwarded-Proto": "https" },
      body: JSON.stringify({ token: "correct-token" }),
    });
    expect(session.status).toBe(204);
    expect(session.headers.get("set-cookie")).toContain("Secure");

    expect((await fetch(`${origin}/private`)).status).toBe(401);
    expect(
      (
        await fetch(`${origin}/private`, {
          headers: { Authorization: "Bearer correct-token" },
        })
      ).status,
    ).toBe(200);
  });

  it("accepts legacy websocket query tokens only from loopback", () => {
    const auth = makeServerAuth("correct-token");
    const request = (remoteAddress: string, authorization?: string) =>
      ({
        headers: authorization ? { authorization } : {},
        socket: { remoteAddress },
      }) as unknown as Http.IncomingMessage;
    const url = new URL("ws://example.test/?token=correct-token");

    expect(auth.isWebSocketRequestAuthenticated(request("127.0.0.1"), url)).toBe(true);
    expect(auth.isWebSocketRequestAuthenticated(request("10.0.0.5"), url)).toBe(false);
    expect(
      auth.isWebSocketRequestAuthenticated(request("10.0.0.5", "Bearer correct-token"), url),
    ).toBe(true);
  });

  it("honors forwarded headers only from loopback and listed proxies", () => {
    const request = (remoteAddress: string, headers: Record<string, string>) =>
      ({ headers, socket: { remoteAddress } }) as unknown as Http.IncomingMessage;
    const https = { "x-forwarded-proto": "https" };

    expect(requestUsesTls(request("127.0.0.1", https))).toBe(true);
    expect(requestUsesTls(request("::ffff:127.0.0.1", https))).toBe(true);
    // A direct client wrote this header itself.
    expect(requestUsesTls(request("10.0.0.5", https))).toBe(false);
    const listed = makeTrustedProxyCheck(["10.0.0.5", " 172.16.0.0/12 ", "fd00::/8", ""]);
    for (const address of ["10.0.0.5", "::ffff:10.0.0.5", "172.31.4.4", "fd12::1", "::1"]) {
      expect(listed(address), address).toBe(true);
      expect(requestUsesTls(request(address, https), listed), address).toBe(true);
    }
    for (const address of ["10.0.0.6", "172.32.0.1", "fe80::1", "unknown"]) {
      expect(listed(address), address).toBe(false);
    }
    for (const entry of [
      "proxy.example",
      "10.0.0.0/33",
      "10.0.0.0/8/8",
      "fd00::/129",
      "10.0.0.0/",
    ]) {
      expect(() => makeTrustedProxyCheck([entry]), entry).toThrow(/Invalid trusted proxy/u);
    }

    const auth = makeServerAuth("correct-token", { trustedProxies: ["10.0.0.5"] });
    const proxied = (remoteAddress: string) =>
      request(remoteAddress, { ...https, host: "f5.example", origin: "https://f5.example" });
    expect(auth.isWebSocketOriginAllowed(proxied("10.0.0.5"))).toBe(true);
    expect(auth.externalRequestOrigin(proxied("10.0.0.5"))).toBe("https://f5.example");
    expect(auth.ignoredForwardedProtoPeer(proxied("10.0.0.5"))).toBeNull();
    expect(auth.isWebSocketOriginAllowed(proxied("10.0.0.6"))).toBe(false);
    expect(auth.externalRequestOrigin(proxied("10.0.0.6"))).toBe("http://f5.example");
    expect(auth.ignoredForwardedProtoPeer(proxied("10.0.0.6"))).toBe("10.0.0.6");
    expect(auth.ignoredForwardedProtoPeer(request("10.0.0.6", {}))).toBeNull();

    // The query token is for clients on this machine, not ones a local proxy forwards for.
    const url = new URL("ws://example.test/?token=correct-token");
    const forwardedFor = (remoteAddress: string, value: string) =>
      request(remoteAddress, { "x-forwarded-for": value });
    expect(auth.isWebSocketRequestAuthenticated(forwardedFor("127.0.0.1", "127.0.0.1"), url)).toBe(
      true,
    );
    expect(
      auth.isWebSocketRequestAuthenticated(forwardedFor("127.0.0.1", "203.0.113.9"), url),
    ).toBe(false);
    expect(
      auth.isWebSocketRequestAuthenticated(forwardedFor("10.0.0.5", "203.0.113.9, 10.0.0.5"), url),
    ).toBe(false);
    // An untrusted peer cannot claim to be forwarding for loopback.
    expect(auth.isWebSocketRequestAuthenticated(forwardedFor("10.0.0.6", "127.0.0.1"), url)).toBe(
      false,
    );
  });

  it("limits logins per forwarded client, so one client cannot lock out the rest", async () => {
    const auth = makeServerAuth("correct-token", { maxFailuresPerSource: 2 });
    const origin = await startAuthServer(auth);
    const authenticate = (token: string, forwardedFor: string) =>
      fetch(`${origin}/auth/session`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Forwarded-For": forwardedFor },
        body: JSON.stringify({ token }),
      });

    expect((await authenticate("wrong", "198.51.100.1")).status).toBe(401);
    expect((await authenticate("wrong", "198.51.100.1")).status).toBe(429);
    // Entries the client put in front of the one the proxy appended change nothing.
    expect((await authenticate("correct-token", "198.51.100.7, 198.51.100.1")).status).toBe(429);
    expect((await authenticate("correct-token", "[198.51.100.1]:4711")).status).toBe(429);
    expect((await authenticate("correct-token", "198.51.100.2")).status).toBe(204);
  });

  it("counts wrong bearer tokens from remote clients toward the login limits", () => {
    let now = 1_000;
    const auth = makeServerAuth("correct-token", {
      now: () => now,
      maxFailuresPerSource: 2,
      lockoutMs: 10_000,
    });
    const request = (remoteAddress: string, token: string) =>
      ({
        headers: { authorization: `Bearer ${token}` },
        socket: { remoteAddress },
      }) as unknown as Http.IncomingMessage;
    const accepted = (remoteAddress: string, token = "correct-token") =>
      auth.isHttpRequestAuthenticated(request(remoteAddress, token));

    // One request is one failure, however often it is checked.
    const wrong = request("10.0.0.5", "wrong");
    expect(auth.isHttpRequestAuthenticated(wrong)).toBe(false);
    expect(auth.isHttpRequestAuthenticated(wrong)).toBe(false);
    expect(accepted("10.0.0.5")).toBe(true);

    expect(accepted("10.0.0.5", "wrong-again")).toBe(false);
    // Locked out: even the right token is refused, from this client only.
    expect(accepted("10.0.0.5")).toBe(false);
    expect(accepted("10.0.0.6")).toBe(true);
    now += 10_001;
    expect(accepted("10.0.0.5")).toBe(true);

    // The desktop app reconnects from loopback and is never locked out.
    for (let attempt = 0; attempt < 10; attempt += 1) {
      expect(accepted("127.0.0.1", "stale")).toBe(false);
    }
    expect(accepted("127.0.0.1")).toBe(true);
  });

  it("answers a token-less server only under loopback names", () => {
    const request = (host: string | undefined) =>
      ({
        headers: host === undefined ? {} : { host },
        socket: { remoteAddress: "127.0.0.1" },
      }) as unknown as Http.IncomingMessage;
    const open = makeServerAuth(undefined);

    for (const host of [
      "localhost",
      "localhost:3773",
      "LOCALHOST.:3773",
      "work.localhost:3773",
      "127.0.0.1:3773",
      "127.8.9.10",
      "[::1]:3773",
      // Non-browser clients may omit Host; only browsers can be rebound.
      undefined,
    ]) {
      expect(open.isRequestHostAllowed(request(host)), String(host)).toBe(true);
    }
    for (const host of [
      "attacker.example:3773",
      "attacker.example",
      "localhost.attacker.example:3773",
      "127.0.0.1.attacker.example",
      "notlocalhost:3773",
      "192.168.1.42:3773",
      "[fe80::1]:3773",
      "",
      "local host",
    ]) {
      expect(open.isRequestHostAllowed(request(host)), host).toBe(false);
    }

    // With a token the name no longer matters: the credential authorizes the request.
    const remote = makeServerAuth("correct-token-correct-token");
    expect(remote.isRequestHostAllowed(request("f5.tailnet.example:3773"))).toBe(true);
  });

  it("allows configured websocket origins without weakening same-origin checks", () => {
    const auth = makeServerAuth("correct-token", {
      allowedWebSocketOrigins: ["t3://app", "http://localhost:5173"],
    });
    const request = (origin: string, host = "127.0.0.1:52243", forwardedProto?: "http" | "https") =>
      ({
        headers: {
          host,
          origin,
          ...(forwardedProto ? { "x-forwarded-proto": forwardedProto } : {}),
        },
        socket: { remoteAddress: "127.0.0.1" },
      }) as unknown as Http.IncomingMessage;

    expect(auth.isWebSocketOriginAllowed(request("t3://app"))).toBe(true);
    expect(auth.isWebSocketOriginAllowed(request("http://localhost:5173"))).toBe(true);
    expect(auth.isWebSocketOriginAllowed(request("http://127.0.0.1:52243"))).toBe(true);
    expect(auth.isWebSocketOriginAllowed(request("t3://other-app"))).toBe(false);
    expect(auth.isWebSocketOriginAllowed(request("https://attacker.example"))).toBe(false);
    expect(auth.isWebSocketOriginAllowed(request("t3://app/unexpected-path"))).toBe(false);
    expect(
      auth.isWebSocketOriginAllowed(request("http://secure.example", "secure.example", "https")),
    ).toBe(false);
    expect(
      auth.isWebSocketOriginAllowed(request("https://secure.example", "secure.example", "https")),
    ).toBe(true);
  });
});

it("keeps two authenticated profiles on one hostname independent", async () => {
  const a = await startAuthServer(makeServerAuth("shared-token", { profileId: "a".repeat(32) }));
  const b = await startAuthServer(makeServerAuth("shared-token", { profileId: "b".repeat(32) }));
  const login = async (origin: string) => {
    const result = await fetch(`${origin}/auth/session`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: "shared-token" }),
    });
    expect(result.status).toBe(204);
    return result.headers.get("set-cookie")!.split(";")[0]!;
  };
  const aCookie = await login(a);
  const bCookie = await login(b);
  expect(aCookie.split("=")[0]).not.toBe(bCookie.split("=")[0]);
  const cookie = `${aCookie}; ${bCookie}`;
  expect((await fetch(`${a}/private`, { headers: { cookie } })).status).toBe(200);
  expect((await fetch(`${b}/private`, { headers: { cookie } })).status).toBe(200);
  const logout = await fetch(`${b}/auth/logout`, { method: "POST", headers: { cookie } });
  expect(logout.headers.get("set-cookie")).toContain("f5_session_" + "b".repeat(32));
  expect((await fetch(`${a}/private`, { headers: { cookie } })).status).toBe(200);
  expect((await fetch(`${b}/private`, { headers: { cookie } })).status).toBe(401);
});
