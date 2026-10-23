// @effect-diagnostics nodeBuiltinImport:off - real proxy tunnel and TLS origin.
import * as Http from "node:http";
import * as Https from "node:https";
import * as Net from "node:net";
import { Effect } from "effect";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { LOCALHOST_TEST_CERT, LOCALHOST_TEST_KEY } from "../testUtils/localhostTls.ts";
import {
  githubTrustedCertificates,
  makeGitHubFetch,
  makeGitHubHttpTransport,
} from "./githubHttpTransport.ts";
import { parseGitHubApiResponse } from "./githubApi.ts";

describe("GitHub HTTP transport", () => {
  it.each([
    ["github.com", "repos/o/r", "https://api.github.com/repos/o/r"],
    ["example.ghe.com", "graphql", "https://api.example.ghe.com/graphql"],
    ["git.example.test", "graphql", "https://git.example.test/api/graphql"],
    [
      "git.example.test",
      "repos/o/r?per_page=100",
      "https://git.example.test/api/v3/repos/o/r?per_page=100",
    ],
  ])("routes %s/%s with private credentials", async (host, endpoint, expected) => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ id: 1 }), {
        headers: { ETag: '"version"', "x-ratelimit-remaining": "15" },
      }),
    );
    const result = await Effect.runPromise(
      makeGitHubHttpTransport(fetcher)({
        cwd: ".",
        args: [
          "api",
          endpoint!,
          "--hostname",
          host!,
          "--method",
          "POST",
          "--include",
          "--header",
          'If-None-Match: "version"',
        ],
        env: { GH_TOKEN: "cloud-secret", GH_ENTERPRISE_TOKEN: "enterprise-secret" },
        stdin: '{"query":"test"}',
      }),
    );
    const [url, options] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(expected);
    expect(options?.redirect).toBe("manual");
    expect(new Headers(options?.headers).get("authorization")).toBe(
      `Bearer ${host!.endsWith(".test") ? "enterprise-secret" : "cloud-secret"}`,
    );
    expect(options?.body).toBe('{"query":"test"}');
    expect(parseGitHubApiResponse(result.stdout)).toMatchObject({
      status: 200,
      body: { id: 1 },
      etag: '"version"',
      rateLimit: { remaining: 15 },
    });
  });
  it("cancels oversized response streams without exposing their content", async () => {
    const canceled = vi.fn();
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("private".repeat(2000)));
          },
          cancel: canceled,
        }),
      ),
    );
    const result = await Effect.runPromise(
      makeGitHubHttpTransport(fetcher)({
        cwd: ".",
        args: ["api", "user", "--hostname", "github.com"],
        maxStdoutBytes: 1024,
      }).pipe(Effect.flip),
    );
    expect(result.detail).not.toContain("private");
    expect(canceled).toHaveBeenCalledOnce();
  });
  it("classifies a stalled request deadline without exposing fetch errors", async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(
      (_url, options) =>
        new Promise<Response>((_resolve, reject) => {
          options?.signal?.addEventListener(
            "abort",
            () => reject(new Error("private fetch payload")),
            { once: true },
          );
        }),
    );
    const result = await Effect.runPromise(
      makeGitHubHttpTransport(fetcher)({
        cwd: ".",
        args: ["api", "user", "--hostname", "github.com"],
        timeoutMs: 5,
      }).pipe(Effect.flip),
    );
    expect(result.kind).toBe("timeout");
    expect(result.detail).not.toContain("private fetch payload");
  });
  it("follows a renamed repository's redirect within the API origin only", async () => {
    const redirect = (location: string) =>
      new Response(null, { status: 301, headers: { Location: location } });
    const request = (fetcher: typeof fetch) =>
      Effect.runPromise(
        makeGitHubHttpTransport(fetcher)({
          cwd: ".",
          args: ["api", "repos/zeit/next.js", "--hostname", "github.com", "--include"],
          env: { GH_TOKEN: "cloud-secret" },
        }),
      );

    const renamed = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(redirect("https://api.github.com/repositories/70107786"))
      .mockResolvedValueOnce(new Response(JSON.stringify({ full_name: "vercel/next.js" })));
    const result = await request(renamed);
    expect(String(renamed.mock.calls[1]![0])).toBe("https://api.github.com/repositories/70107786");
    expect(parseGitHubApiResponse(result.stdout)).toMatchObject({
      status: 200,
      body: { full_name: "vercel/next.js" },
    });

    // Another origin never receives the token: the redirect comes back as a failed response.
    const elsewhere = vi
      .fn<typeof fetch>()
      .mockResolvedValue(redirect("https://attacker.example/repos/zeit/next.js"));
    expect(await request(elsewhere)).toMatchObject({ code: 1 });
    expect(elsewhere).toHaveBeenCalledTimes(1);

    const loop = vi
      .fn<typeof fetch>()
      .mockImplementation(async () => redirect("https://api.github.com/repos/zeit/next.js"));
    expect(await request(loop)).toMatchObject({ code: 1 });
    expect(loop).toHaveBeenCalledTimes(4);
  });
  it("refuses arbitrary headers before sending anything", async () => {
    const fetcher = vi.fn<typeof fetch>();
    const result = await Effect.runPromise(
      makeGitHubHttpTransport(fetcher)({
        cwd: ".",
        args: ["api", "user", "--hostname", "github.com", "--header", "Authorization: stolen"],
      }).pipe(Effect.flip),
    );
    expect(result.kind).toBe("network");
    expect(fetcher).not.toHaveBeenCalled();
  });
});

it("preserves diff text and sends only the fixed diff media type", async () => {
  const fetcher = vi.fn<(...args: Parameters<typeof fetch>) => Promise<Response>>(
    async () => new Response("diff --git a/a b/a\n+hello\n"),
  );
  const result = await Effect.runPromise(
    makeGitHubHttpTransport(fetcher)({
      cwd: "/repo",
      args: [
        "api",
        "repos/octo/repo/pulls/7",
        "--hostname",
        "github.com",
        "--method",
        "GET",
        "--header",
        "Accept: application/vnd.github.diff",
      ],
      env: { GH_TOKEN: "token" },
    }),
  );
  expect(new Headers(fetcher.mock.calls[0]?.[1]?.headers).get("accept")).toBe(
    "application/vnd.github.diff",
  );
  expect(result.stdout).toContain("diff --git a/a b/a\n+hello\n");
});

describe("GitHub fetch parity with gh", () => {
  const sockets = new Set<Net.Socket>();
  const track = (socket: Net.Socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  };
  const listen = (server: Net.Server) =>
    new Promise<number>((resolve) =>
      server.listen(0, "127.0.0.1", () => resolve((server.address() as Net.AddressInfo).port)),
    );
  const origin = Https.createServer(
    { key: LOCALHOST_TEST_KEY, cert: LOCALHOST_TEST_CERT },
    (request, response) => {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ path: request.url, auth: request.headers.authorization }));
    },
  );
  const proxy = Http.createServer();
  const connects: string[] = [];
  let proxyUrl = "";

  beforeAll(async () => {
    origin.on("connection", track);
    proxy.on("connection", track);
    const originPort = await listen(origin);
    // Every CONNECT tunnels to the local origin, whatever port it names.
    proxy.on("connect", (request, socket, head) => {
      connects.push(request.url ?? "");
      const upstream = Net.connect(originPort, "127.0.0.1", () => {
        socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        upstream.write(head);
        upstream.pipe(socket);
        socket.pipe(upstream);
      });
      track(upstream);
      upstream.on("error", () => socket.destroy());
      socket.on("error", () => upstream.destroy());
    });
    proxyUrl = `http://127.0.0.1:${await listen(proxy)}`;
  });
  afterAll(async () => {
    for (const socket of sockets) socket.destroy();
    await Promise.all([origin, proxy].map((server) => new Promise((done) => server.close(done))));
  });

  const request = (fetcher: ReturnType<typeof makeGitHubFetch>) =>
    makeGitHubHttpTransport(fetcher)({
      cwd: ".",
      args: ["api", "repos/o/r", "--hostname", "127.0.0.1", "--include"],
      env: { GH_ENTERPRISE_TOKEN: "enterprise-secret" },
    });

  it("tunnels through HTTPS_PROXY and trusts a root outside Node's bundle", async () => {
    connects.length = 0;
    const fetcher = makeGitHubFetch({
      env: { HTTPS_PROXY: proxyUrl },
      ca: [...(githubTrustedCertificates() ?? []), LOCALHOST_TEST_CERT],
    });

    const result = await Effect.runPromise(request(fetcher));

    expect(connects).toEqual(["127.0.0.1:443"]);
    expect(result.code).toBe(0);
    expect(parseGitHubApiResponse(result.stdout).body).toEqual({
      path: "/api/v3/repos/o/r",
      auth: "Bearer enterprise-secret",
    });
  });

  it("honors NO_PROXY and rejects a root it was not given", async () => {
    connects.length = 0;
    const fetcher = makeGitHubFetch({
      env: { HTTPS_PROXY: proxyUrl, NO_PROXY: "127.0.0.1" },
      ca: githubTrustedCertificates() ?? [],
    });

    const result = await Effect.runPromise(Effect.flip(request(fetcher)));

    expect(connects).toEqual([]);
    expect(result.kind).toBe("network");
  });

  it("adds the system store to Node's default roots", () => {
    expect(
      githubTrustedCertificates((store) => (store === "default" ? ["a", "b"] : ["b", "c"])),
    ).toEqual(["a", "b", "c"]);
    expect(
      githubTrustedCertificates(
        "unavailable" as unknown as Parameters<typeof githubTrustedCertificates>[0],
      ),
    ).toBeUndefined();
    expect(
      githubTrustedCertificates(() => {
        throw new Error("unsupported store");
      }),
    ).toBeUndefined();
  });
});
