import * as Http from "node:http";

import { afterEach, describe, expect, it } from "vitest";

import { makeServerAuth } from "./serverAuth.ts";

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

  it("allows configured websocket origins without weakening same-origin checks", () => {
    const auth = makeServerAuth("correct-token", {
      allowedWebSocketOrigins: ["t3://app", "http://localhost:5173"],
    });
    const request = (origin: string, host = "127.0.0.1:52243") =>
      ({
        headers: { host, origin },
        socket: { remoteAddress: "127.0.0.1" },
      }) as unknown as Http.IncomingMessage;

    expect(auth.isWebSocketOriginAllowed(request("t3://app"))).toBe(true);
    expect(auth.isWebSocketOriginAllowed(request("http://localhost:5173"))).toBe(true);
    expect(auth.isWebSocketOriginAllowed(request("http://127.0.0.1:52243"))).toBe(true);
    expect(auth.isWebSocketOriginAllowed(request("t3://other-app"))).toBe(false);
    expect(auth.isWebSocketOriginAllowed(request("https://attacker.example"))).toBe(false);
    expect(auth.isWebSocketOriginAllowed(request("t3://app/unexpected-path"))).toBe(false);
  });
});
