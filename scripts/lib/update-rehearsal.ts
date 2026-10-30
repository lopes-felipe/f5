// @effect-diagnostics nodeBuiltinImport:off
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import {
  RELEASE_UPDATE_OWNER,
  RELEASE_UPDATE_REPO,
  parseAppUpdateConfig,
  verifyAppUpdateConfig,
} from "./app-update-config.ts";

/**
 * Published baselines are pinned by their release manifest. Keep their original
 * publisher identity so the real updater still enforces signatures. Locally
 * built rehearsal pairs must remain unsigned.
 */
export function verifyRehearsalAppUpdateConfig(
  text: string,
  expected: { readonly channel: string; readonly publishedBaseline?: boolean },
): ReturnType<typeof parseAppUpdateConfig> {
  const config = parseAppUpdateConfig(text);
  let publisherName: string | undefined;
  if (expected.publishedBaseline && config.publisherName !== undefined) {
    const names =
      typeof config.publisherName === "string" ? [config.publisherName] : config.publisherName;
    if (names.length !== 1 || !names[0]?.trim())
      throw new Error("Published baseline must have exactly one nonempty update publisherName");
    publisherName = names[0];
  }
  verifyAppUpdateConfig(text, { channel: expected.channel, publisherName });
  return config;
}

/**
 * Versions for the unpublished rehearsal pair, matching the release channel:
 * stable `0.1.0-dryrun.7` → 0.1.0 → 0.1.1; beta `0.2.0-beta.3` → 0.2.0-beta.1 →
 * 0.2.0-beta.2, so beta rehearsals resolve updates through the Atom feed.
 */
export function rehearsalVersions(
  version: string,
  channel: string,
): { baseline: string; target: string } {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.-]+)?$/.exec(version);
  if (!match) throw new Error(`Invalid release version: ${version}`);
  const [, major, minor, patch] = match as unknown as [string, string, string, string];
  const core = `${major}.${minor}.${patch}`;
  if (channel === "beta") return { baseline: `${core}-beta.1`, target: `${core}-beta.2` };
  if (channel !== "latest") throw new Error(`Invalid release channel: ${channel}`);
  return { baseline: core, target: `${major}.${minor}.${Number(patch) + 1}` };
}

/**
 * Points an installed production `app-update.yml` at the loopback emulator while
 * keeping electron-updater's GitHub provider (custom hosts use `/api/v3`).
 */
export function rehearsalAppUpdateConfig(original: string, port: number): string {
  const config = parseAppUpdateConfig(original);
  if (config.provider !== "github" || config.owner !== RELEASE_UPDATE_OWNER)
    throw new Error("Rehearsal expects the production GitHub feed");
  if ("host" in config || "protocol" in config)
    throw new Error("app-update.yml already overrides the host");
  return `${original.trimEnd()}\nhost: 127.0.0.1:${port}\nprotocol: http\n`;
}

export type FeedMode = "normal" | "offline" | "corrupt-manifest" | "drop-installer";

export interface FeedRelease {
  readonly version: string;
  /** Asset name → file path. */
  readonly assets: Readonly<Record<string, string>>;
}

export interface UpdateFeedEmulator {
  readonly port: number;
  readonly requests: string[];
  setMode(mode: FeedMode): void;
  close(): Promise<void>;
}

const corruptSha512 = createHash("sha512").update("corrupt").digest("base64");

function send(response: ServerResponse, status: number, body: string | Buffer, type: string) {
  response.writeHead(status, { "content-type": type, "content-length": Buffer.byteLength(body) });
  response.end(body);
}

function sendAsset(request: IncomingMessage, response: ServerResponse, bytes: Buffer) {
  const range = /^bytes=(\d+)-(\d*)$/.exec(request.headers.range ?? "");
  if (!range) return send(response, 200, bytes, "application/octet-stream");
  const start = Number(range[1]);
  const end = range[2] ? Math.min(Number(range[2]), bytes.length - 1) : bytes.length - 1;
  if (start > end) {
    response.writeHead(416, { "content-range": `bytes */${bytes.length}` });
    return response.end();
  }
  const slice = bytes.subarray(start, end + 1);
  response.writeHead(206, {
    "content-type": "application/octet-stream",
    "content-length": slice.length,
    "content-range": `bytes ${start}-${end}/${bytes.length}`,
  });
  response.end(slice);
}

/**
 * Serves the GitHub Enterprise-shaped routes electron-updater 6.8.3 requests for a
 * custom host: the releases Atom feed, `/api/v3/.../releases/latest`, and release
 * downloads (with single-range support for differential downloads).
 */
export async function startUpdateFeedEmulator(options: {
  readonly releases: readonly FeedRelease[];
  readonly latest: string;
}): Promise<UpdateFeedEmulator> {
  let mode: FeedMode = "normal";
  const requests: string[] = [];
  const base = `/${RELEASE_UPDATE_OWNER}/${RELEASE_UPDATE_REPO}/releases`;
  const server = createServer((request, response) => {
    const path = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    requests.push(`${mode} ${path}`);
    if (mode === "offline") return request.socket.destroy();
    if (path === `${base}.atom`) {
      const host = request.headers.host;
      const entries = [...options.releases]
        .reverse()
        .map(
          (release) =>
            `<entry><id>tag:github.com,2008:Repository/1/v${release.version}</id><updated>2026-10-17T00:00:00Z</updated><link rel="alternate" type="text/html" href="http://${host}${base}/tag/v${release.version}"/><title>${release.version}</title><content type="html">Rehearsal ${release.version}</content></entry>`,
        )
        .join("");
      return send(
        response,
        200,
        `<?xml version="1.0" encoding="UTF-8"?><feed xmlns="http://www.w3.org/2005/Atom">${entries}</feed>`,
        "application/atom+xml",
      );
    }
    if (path === `/api/v3/repos/${RELEASE_UPDATE_OWNER}/${RELEASE_UPDATE_REPO}/releases/latest`)
      return send(
        response,
        200,
        JSON.stringify({ tag_name: `v${options.latest}` }),
        "application/json",
      );
    const download = new RegExp(`^${base}/download/v([^/]+)/([^/]+)$`).exec(path);
    const release = download && options.releases.find((entry) => entry.version === download[1]);
    const file = release && release.assets[download[2]!];
    if (!download || !file) return send(response, 404, "Not Found", "text/plain");
    const name = download[2]!;
    const bytes = readFileSync(file);
    if (name.endsWith(".yml")) {
      const text = bytes.toString("utf8");
      return send(
        response,
        200,
        mode === "corrupt-manifest"
          ? text.replace(/sha512: \S+/g, `sha512: ${corruptSha512}`)
          : text,
        "text/yaml",
      );
    }
    if (mode === "drop-installer" && name.endsWith(".exe")) {
      response.writeHead(200, {
        "content-type": "application/octet-stream",
        "content-length": bytes.length,
      });
      response.write(bytes.subarray(0, Math.floor(bytes.length / 2)));
      return request.socket.destroy();
    }
    return sendAsset(request, response, bytes);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    port: (server.address() as AddressInfo).port,
    requests,
    setMode: (next) => {
      mode = next;
    },
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}
