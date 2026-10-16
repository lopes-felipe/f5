import { EventEmitter } from "node:events";
import type https from "node:https";

import { describe, expect, it } from "vitest";

import {
  isPublicAddress,
  makeOutboundHttps,
  OutboundPolicyError,
  resolvePublicAddress,
  validateOutboundUrl,
} from "./outboundHttps.ts";

describe("isPublicAddress", () => {
  it.each([
    "127.0.0.1",
    "10.1.2.3",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.1.1",
    "169.254.169.254",
    "100.64.0.1",
    "100.127.255.255",
    "0.0.0.0",
    "224.0.0.1",
    "240.0.0.1",
    "255.255.255.255",
    "192.0.2.10",
    "198.18.0.1",
    "::",
    "::1",
    "fc00::1",
    "fd12:3456::1",
    "fe80::1",
    "ff02::1",
    "::ffff:127.0.0.1",
    "::ffff:10.0.0.1",
    "64:ff9b::a00:1",
    "2001:db8::1",
    "2002:c000:204::1",
  ])("rejects %s", (address) => {
    expect(isPublicAddress(address)).toBe(false);
  });

  it.each([
    "8.8.8.8",
    "1.1.1.1",
    "172.32.0.1",
    "100.128.0.1",
    "2606:4700:4700::1111",
    "::ffff:8.8.8.8",
  ])("accepts %s", (address) => {
    expect(isPublicAddress(address)).toBe(true);
  });

  it("rejects things that are not addresses", () => {
    expect(isPublicAddress("example.com")).toBe(false);
  });
});

describe("validateOutboundUrl", () => {
  it("allows https on 443 only, without credentials or fragments", () => {
    expect(validateOutboundUrl("https://chatgpt.com/oauth/client.json").hostname).toBe(
      "chatgpt.com",
    );
    expect(validateOutboundUrl("https://chatgpt.com:443/x").port).toBe("");
    for (const url of [
      "http://chatgpt.com/x",
      "https://chatgpt.com:8443/x",
      "https://user:pass@chatgpt.com/x",
      "https://chatgpt.com/x#frag",
      "not a url",
    ])
      expect(() => validateOutboundUrl(url)).toThrow(OutboundPolicyError);
  });
});

describe("resolvePublicAddress", () => {
  it("rejects a mixed answer containing a non-public address", async () => {
    await expect(
      resolvePublicAddress("mixed.example", async () => [
        { address: "8.8.8.8", family: 4 },
        { address: "10.0.0.1", family: 4 },
      ]),
    ).rejects.toMatchObject({ reason: "non-public-address" });
  });

  it("rejects private IP literals without resolving", async () => {
    let resolved = false;
    await expect(
      resolvePublicAddress("127.0.0.1", async () => {
        resolved = true;
        return [];
      }),
    ).rejects.toMatchObject({ reason: "non-public-address" });
    expect(resolved).toBe(false);
  });

  it("returns a public answer", async () => {
    expect(
      await resolvePublicAddress("ok.example", async () => [{ address: "1.1.1.1", family: 4 }]),
    ).toEqual({ address: "1.1.1.1", family: 4 });
  });
});

describe("makeOutboundHttps", () => {
  /** A fake `https.request` that answers with the given status and body. */
  const fakeRequest = (status: number, body: string, seen: Array<Record<string, unknown>> = []) =>
    ((options: Record<string, unknown>, callback: (response: EventEmitter) => void) => {
      seen.push(options);
      const request = new EventEmitter() as EventEmitter & {
        write: () => void;
        end: () => void;
      };
      request.write = () => undefined;
      request.end = () => {
        const response = new EventEmitter() as EventEmitter & {
          statusCode: number;
          headers: Record<string, string>;
          destroy: () => void;
        };
        response.statusCode = status;
        response.headers = {};
        response.destroy = () => undefined;
        callback(response);
        queueMicrotask(() => {
          response.emit("data", Buffer.from(body));
          response.emit("end");
        });
      };
      return request;
    }) as unknown as typeof https.request;

  it("never connects when DNS returns a private address", async () => {
    const seen: Array<Record<string, unknown>> = [];
    const outbound = makeOutboundHttps({
      resolver: async () => [{ address: "192.168.0.10", family: 4 }],
      request: fakeRequest(200, "{}", seen),
    });
    await expect(outbound({ url: "https://internal.example/x" })).rejects.toMatchObject({
      reason: "non-public-address",
    });
    expect(seen).toHaveLength(0);
  });

  it("keeps the hostname for TLS and Host while connecting to the validated address", async () => {
    const seen: Array<Record<string, unknown>> = [];
    const outbound = makeOutboundHttps({
      resolver: async () => [{ address: "93.184.216.34", family: 4 }],
      request: fakeRequest(200, '{"ok":true}', seen),
    });
    const response = await outbound({ url: "https://client.example/meta.json" });
    expect(response).toMatchObject({ status: 200, body: '{"ok":true}' });
    expect(seen[0]).toMatchObject({
      hostname: "client.example",
      servername: "client.example",
      port: 443,
      path: "/meta.json",
    });
    expect((seen[0]!.headers as Record<string, string>).host).toBe("client.example");
  });

  it("treats redirects as failures", async () => {
    const outbound = makeOutboundHttps({
      resolver: async () => [{ address: "93.184.216.34", family: 4 }],
      request: fakeRequest(302, ""),
    });
    await expect(outbound({ url: "https://client.example/x" })).rejects.toMatchObject({
      reason: "redirect",
    });
  });

  it("caps the response size", async () => {
    const outbound = makeOutboundHttps({
      resolver: async () => [{ address: "93.184.216.34", family: 4 }],
      request: fakeRequest(200, "x".repeat(70 * 1024)),
    });
    await expect(outbound({ url: "https://client.example/x" })).rejects.toMatchObject({
      reason: "too-large",
    });
  });

  it("caps the request size", async () => {
    const outbound = makeOutboundHttps({
      resolver: async () => [{ address: "93.184.216.34", family: 4 }],
      request: fakeRequest(200, ""),
    });
    await expect(
      outbound({ url: "https://client.example/x", method: "POST", body: "x".repeat(300 * 1024) }),
    ).rejects.toMatchObject({ reason: "too-large" });
  });
});
