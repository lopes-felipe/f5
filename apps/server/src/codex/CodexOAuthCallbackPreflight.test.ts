import net from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import {
  CodexOAuthCallbackPreflightError,
  preflightCodexOAuthCallback,
  readCodexOAuthCallbackUrl,
} from "./CodexOAuthCallbackPreflight.ts";

const servers: net.Server[] = [];

async function listenOnLoopback(host = "127.0.0.1"): Promise<number> {
  const server = net.createServer();
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, host, () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Expected TCP server address.");
  }
  return address.port;
}

async function readUnusedLoopbackPort(): Promise<number> {
  const port = await listenOnLoopback();
  const server = servers.pop();
  await new Promise<void>((resolve) => {
    if (!server) {
      resolve();
      return;
    }
    server.close(() => resolve());
  });
  return port;
}

describe("CodexOAuthCallbackPreflight", () => {
  afterEach(async () => {
    await Promise.all(
      servers.splice(0).map(
        (server) =>
          new Promise<void>((resolve) => {
            server.close(() => resolve());
          }),
      ),
    );
  });

  it("reads redirect_uri from the authorization URL before configured fallbacks", () => {
    const callbackUrl = readCodexOAuthCallbackUrl({
      authorizationUrl:
        "https://auth.example.test/login?redirect_uri=http%3A%2F%2F127.0.0.1%3A3118%2Fcallback",
      mcpOAuthCallbackUrl: "http://127.0.0.1:4118/callback",
    });

    expect(callbackUrl?.toString()).toBe("http://127.0.0.1:3118/callback");
  });

  it("succeeds when a loopback callback listener is reachable", async () => {
    const port = await listenOnLoopback();

    await expect(
      preflightCodexOAuthCallback({
        authorizationUrl: "https://auth.example.test/login",
        mcpOAuthCallbackPort: port,
        timeoutMs: 20,
        retryIntervalMs: 5,
      }),
    ).resolves.toBeUndefined();
  });

  it("expands localhost to loopback addresses", async () => {
    const port = await listenOnLoopback("127.0.0.1");

    await expect(
      preflightCodexOAuthCallback({
        authorizationUrl: `https://auth.example.test/login?redirect_uri=${encodeURIComponent(
          `http://localhost:${port}/callback`,
        )}`,
        timeoutMs: 20,
        retryIntervalMs: 5,
      }),
    ).resolves.toBeUndefined();
  });

  it("supports bracketed IPv6 loopback callbacks", async () => {
    let port: number;
    try {
      port = await listenOnLoopback("::1");
    } catch (error) {
      if (error instanceof Error && "code" in error) {
        return;
      }
      throw error;
    }

    await expect(
      preflightCodexOAuthCallback({
        authorizationUrl: `https://auth.example.test/login?redirect_uri=${encodeURIComponent(
          `http://[::1]:${port}/callback`,
        )}`,
        timeoutMs: 20,
        retryIntervalMs: 5,
      }),
    ).resolves.toBeUndefined();
  });

  it("uses configured callback URL when the authorization URL has no redirect_uri", async () => {
    const port = await listenOnLoopback();

    await expect(
      preflightCodexOAuthCallback({
        authorizationUrl: "https://auth.example.test/login",
        mcpOAuthCallbackUrl: `http://127.0.0.1:${port}/callback`,
        timeoutMs: 20,
        retryIntervalMs: 5,
      }),
    ).resolves.toBeUndefined();
  });

  it("skips non-loopback callback listeners", async () => {
    await expect(
      preflightCodexOAuthCallback({
        authorizationUrl:
          "https://auth.example.test/login?redirect_uri=https%3A%2F%2Fcallback.example.test%2Fcallback",
        timeoutMs: 20,
        retryIntervalMs: 5,
      }),
    ).resolves.toBeUndefined();
  });

  it("skips invalid authorization URLs without configured callback fallbacks", async () => {
    await expect(
      preflightCodexOAuthCallback({
        authorizationUrl: "not a url",
        timeoutMs: 20,
        retryIntervalMs: 5,
      }),
    ).resolves.toBeUndefined();
  });

  it("fails when a loopback callback listener is not reachable", async () => {
    const port = await readUnusedLoopbackPort();

    await expect(
      preflightCodexOAuthCallback({
        authorizationUrl: `https://auth.example.test/login?redirect_uri=${encodeURIComponent(
          `http://127.0.0.1:${port}/callback`,
        )}`,
        timeoutMs: 20,
        retryIntervalMs: 5,
      }),
    ).rejects.toBeInstanceOf(CodexOAuthCallbackPreflightError);
  });
});
