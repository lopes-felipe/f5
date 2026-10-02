import type { IncomingMessage, ServerResponse } from "node:http";

export const GITHUB_MEDIA_MAX_BYTES = 100 * 1024 * 1024;

export interface GitHubMediaProxyOptions {
  readonly configuredHosts?: readonly string[];
  readonly resolveToken: (host: string) => Promise<string | undefined>;
  readonly fetch?: (url: string | URL, init?: RequestInit) => Promise<Response>;
}

export function isAllowedGitHubMediaUrl(
  url: URL,
  configuredHosts: readonly string[] = [],
): boolean {
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    (url.port && url.port !== "443")
  ) {
    return false;
  }
  return (
    (url.hostname === "github.com" && url.pathname.startsWith("/user-attachments/")) ||
    url.hostname.endsWith(".githubusercontent.com") ||
    configuredHosts.some(
      (host) => host.toLowerCase() !== "github.com" && host.toLowerCase() === url.hostname,
    )
  );
}

/** The caller must authenticate the local HTTP request before invoking this handler. */
export function createGitHubMediaProxy(options: GitHubMediaProxyOptions) {
  const fetchMedia = options.fetch ?? globalThis.fetch;
  const hosts = options.configuredHosts ?? [];
  return async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const controller = new AbortController();
    let reader: Pick<ReadableStreamDefaultReader<Uint8Array>, "read" | "cancel"> | undefined;
    const abort = () => {
      controller.abort();
      void reader?.cancel().catch(() => undefined);
    };
    request.on("aborted", abort);
    response.on("close", abort);
    const timeout = setTimeout(abort, 60_000);
    timeout.unref();
    const fail = (status: number, message: string) => {
      if (response.headersSent) response.destroy();
      else {
        response.writeHead(status, { "Content-Type": "text/plain", "Cache-Control": "no-store" });
        response.end(message);
      }
    };
    try {
      if (request.method !== "GET") {
        fail(405, "Method not allowed");
        return;
      }
      const query = new URL(request.url ?? "", "http://localhost").searchParams;
      let url: URL;
      try {
        url = new URL(query.get("url") ?? "");
      } catch {
        fail(400, "Invalid media URL");
        return;
      }
      const host = (query.get("host") ?? "github.com").toLowerCase();
      if (host !== "github.com" && !hosts.some((configured) => configured.toLowerCase() === host)) {
        fail(400, "Unknown GitHub host");
        return;
      }
      if (!isAllowedGitHubMediaUrl(url, hosts)) {
        fail(400, "Media URL is not allowed");
        return;
      }
      const range = request.headers.range;
      if (range !== undefined && !/^bytes=(?:\d+-\d*|-\d+)$/.test(range)) {
        fail(416, "Unsupported media range");
        return;
      }
      const token = await options.resolveToken(host);
      let upstream: Response | undefined;
      for (let redirects = 0; redirects <= 5; redirects++) {
        const headers: Record<string, string> = {
          Accept: "image/*,video/*",
          "Accept-Encoding": "identity",
        };
        if (range) headers.Range = range;
        if (token && url.hostname === host) headers.Authorization = `Bearer ${token}`;
        upstream = await fetchMedia(url, {
          headers,
          redirect: "manual",
          signal: controller.signal,
        });
        if (![301, 302, 303, 307, 308].includes(upstream.status)) break;
        const location = upstream.headers.get("location");
        await upstream.body?.cancel();
        if (!location || redirects === 5) {
          fail(502, "Invalid media redirect");
          return;
        }
        url = new URL(location, url);
        if (!isAllowedGitHubMediaUrl(url, hosts)) {
          fail(502, "Media redirect is not allowed");
          return;
        }
      }
      if (!upstream) {
        fail(502, "Media unavailable");
        return;
      }
      if (upstream.status !== 200 && upstream.status !== 206) {
        await upstream.body?.cancel();
        fail(upstream.status === 416 ? 416 : 502, "Media unavailable");
        return;
      }
      const type = upstream.headers.get("content-type") ?? "";
      const length = upstream.headers.get("content-length");
      const contentRange = upstream.headers.get("content-range");
      const total = contentRange?.match(/^bytes \d+-\d+\/(\d+)$/)?.[1];
      if (!/^(image|video)\/[a-z0-9.+-]+(?:\s*;|$)/i.test(type) || !upstream.body) {
        await upstream.body?.cancel();
        fail(415, "Only image and video media are supported");
        return;
      }
      if (
        (length && Number(length) > GITHUB_MEDIA_MAX_BYTES) ||
        (total && Number(total) > GITHUB_MEDIA_MAX_BYTES)
      ) {
        await upstream.body.cancel();
        fail(413, "Media exceeds the size limit");
        return;
      }
      const headers: Record<string, string> = {
        "Content-Type": type,
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "sandbox; default-src 'none'",
      };
      if (length && /^\d+$/.test(length)) headers["Content-Length"] = length;
      if (
        upstream.status === 206 &&
        contentRange &&
        /^bytes \d+-\d+\/(?:\d+|\*)$/.test(contentRange)
      )
        headers["Content-Range"] = contentRange;
      if (upstream.headers.get("accept-ranges") === "bytes") headers["Accept-Ranges"] = "bytes";
      response.writeHead(upstream.status, headers);
      const streamReader = upstream.body.getReader();
      reader = streamReader;
      let bytes = 0;
      while (!controller.signal.aborted) {
        const chunk = await streamReader.read();
        if (chunk.done) break;
        bytes += chunk.value.byteLength;
        if (bytes > GITHUB_MEDIA_MAX_BYTES) {
          controller.abort();
          response.destroy();
          return;
        }
        if (!response.write(chunk.value)) {
          await new Promise<void>((resolve) => {
            const done = () => {
              response.off("drain", done);
              controller.signal.removeEventListener("abort", done);
              resolve();
            };
            response.once("drain", done);
            controller.signal.addEventListener("abort", done, { once: true });
            if (controller.signal.aborted) done();
          });
        }
      }
      if (!controller.signal.aborted) response.end();
    } catch {
      fail(502, "Media unavailable");
    } finally {
      controller.abort();
      await reader?.cancel().catch(() => undefined);
      clearTimeout(timeout);
      request.off("aborted", abort);
      response.off("close", abort);
    }
  };
}
