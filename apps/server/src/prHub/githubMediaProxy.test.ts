import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it, vi } from "vitest";

import {
  createGitHubMediaProxy,
  GITHUB_MEDIA_MAX_BYTES,
  isAllowedGitHubMediaUrl,
  type GitHubMediaProxyOptions,
} from "./githubMediaProxy.ts";

async function withProxy(
  fetchMedia: NonNullable<GitHubMediaProxyOptions["fetch"]>,
  run: (
    request: (url: string, host?: string, range?: string) => Promise<Response>,
  ) => Promise<void>,
) {
  const server = createServer(
    createGitHubMediaProxy({
      configuredHosts: ["git.example.com"],
      resolveToken: async (host) =>
        host === "git.example.com" ? "enterprise-secret" : "github-secret",
      fetch: fetchMedia,
    }),
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  try {
    await run((url, host = "github.com", range) =>
      fetch(`http://127.0.0.1:${port}/api/prhub/media?${new URLSearchParams({ url, host })}`, {
        headers: range ? { Range: range } : {},
      }),
    );
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

describe("GitHub media proxy", () => {
  it("allows only HTTPS attachment, GitHub content and explicitly configured enterprise hosts", () => {
    for (const url of [
      "https://github.com/user-attachments/assets/123",
      "https://private-user-images.githubusercontent.com/a",
      "https://git.example.com/uploads/a",
    ]) {
      expect(isAllowedGitHubMediaUrl(new URL(url), ["git.example.com"])).toBe(true);
    }
    for (const url of [
      "http://github.com/user-attachments/a",
      "https://github.com/repos/a",
      "https://github.com.evil.test/user-attachments/a",
      "https://evilgithubusercontent.com/a",
      "https://githubusercontent.com/a",
      "https://git.example.com.evil.test/a",
      "https://token@github.com/user-attachments/a",
      "https://github.com:444/user-attachments/a",
    ]) {
      expect(isAllowedGitHubMediaUrl(new URL(url), ["git.example.com"])).toBe(false);
    }
  });

  it("rejects an escaping redirect and cancels its body before any second fetch", async () => {
    const cancelled = vi.fn();
    const fetchMedia = vi.fn<NonNullable<GitHubMediaProxyOptions["fetch"]>>(
      async () =>
        new Response(new ReadableStream({ cancel: cancelled }), {
          status: 302,
          headers: { location: "https://internal.example.com/secret" },
        }),
    );
    await withProxy(fetchMedia, async (request) => {
      expect((await request("https://github.com/user-attachments/a")).status).toBe(502);
    });
    expect(fetchMedia).toHaveBeenCalledTimes(1);
    expect(cancelled).toHaveBeenCalledTimes(1);
  });

  it("never sends an enterprise token to GitHub content or another allowlisted host", async () => {
    const fetchMedia = vi.fn<NonNullable<GitHubMediaProxyOptions["fetch"]>>(async (_url, init) => {
      expect(init?.redirect).toBe("manual");
      if (fetchMedia.mock.calls.length === 1) {
        expect(new Headers(init?.headers).get("authorization")).toBe("Bearer enterprise-secret");
        return new Response(null, {
          status: 302,
          headers: { location: "https://private-user-images.githubusercontent.com/a" },
        });
      }
      expect(new Headers(init?.headers).get("authorization")).toBeNull();
      return new Response("image", { headers: { "content-type": "image/png" } });
    });
    await withProxy(fetchMedia, async (request) => {
      expect(
        await (await request("https://git.example.com/uploads/a", "git.example.com")).text(),
      ).toBe("image");
    });
    expect(fetchMedia).toHaveBeenCalledTimes(2);
  });

  it("forwards a single Range and only safe media response headers", async () => {
    const fetchMedia = vi.fn<NonNullable<GitHubMediaProxyOptions["fetch"]>>(async (_url, init) => {
      expect(new Headers(init?.headers).get("range")).toBe("bytes=2-4");
      return new Response("abc", {
        status: 206,
        headers: {
          "content-type": "video/mp4",
          "content-range": "bytes 2-4/10",
          "content-length": "3",
          "accept-ranges": "bytes",
          "set-cookie": "secret=yes",
          location: "https://evil.test",
        },
      });
    });
    await withProxy(fetchMedia, async (request) => {
      const result = await request("https://github.com/user-attachments/a", undefined, "bytes=2-4");
      expect(result.status).toBe(206);
      expect(result.headers.get("content-range")).toBe("bytes 2-4/10");
      expect(result.headers.get("set-cookie")).toBeNull();
      expect(result.headers.get("location")).toBeNull();
      expect(result.headers.get("x-content-type-options")).toBe("nosniff");
      expect(await result.text()).toBe("abc");
      expect(
        (await request("https://github.com/user-attachments/a", undefined, "bytes=1-2,4-5")).status,
      ).toBe(416);
    });
    expect(fetchMedia).toHaveBeenCalledTimes(1);
  });

  it("cancels non-media and oversized responses without forwarding their bytes", async () => {
    for (const headers of [
      { "content-type": "text/html" },
      { "content-type": "image/png", "content-length": String(GITHUB_MEDIA_MAX_BYTES + 1) },
      { "content-type": "video/mp4", "content-range": `bytes 0-2/${GITHUB_MEDIA_MAX_BYTES + 1}` },
    ]) {
      const cancelled = vi.fn();
      await withProxy(
        async () => new Response(new ReadableStream({ cancel: cancelled }), { headers }),
        async (request) => {
          const result = await request("https://github.com/user-attachments/a");
          expect([413, 415]).toContain(result.status);
        },
      );
      expect(cancelled).toHaveBeenCalledOnce();
    }
  });

  it("rejects unknown account hosts and forbidden initial URLs without resolving upstream", async () => {
    const fetchMedia = vi.fn<NonNullable<GitHubMediaProxyOptions["fetch"]>>();
    await withProxy(fetchMedia, async (request) => {
      expect(
        (await request("https://github.com/user-attachments/a", "unknown.example.com")).status,
      ).toBe(400);
      expect((await request("https://example.com/a")).status).toBe(400);
    });
    expect(fetchMedia).not.toHaveBeenCalled();
  });

  it("cancels a stalled upstream stream when the downstream client disconnects", async () => {
    let notifyCancelled: () => void = () => undefined;
    const cancelled = new Promise<void>((resolve) => {
      notifyCancelled = resolve;
    });
    let upstreamSignal: AbortSignal | null | undefined;
    await withProxy(
      async (_url, init) => {
        upstreamSignal = init?.signal;
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new Uint8Array([1]));
            },
            cancel() {
              notifyCancelled();
            },
          }),
          { headers: { "content-type": "image/png" } },
        );
      },
      async (request) => {
        const result = await request("https://github.com/user-attachments/a");
        const reader = result.body!.getReader();
        await reader.read();
        await reader.cancel();
        await cancelled;
        expect(upstreamSignal?.aborted).toBe(true);
      },
    );
  });
});
