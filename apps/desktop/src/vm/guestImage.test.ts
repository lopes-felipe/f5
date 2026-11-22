import * as Crypto from "node:crypto";
import * as FS from "node:fs";
import * as OS from "node:os";
import * as Path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ensureGuestImage,
  GuestImageError,
  guestImagePath,
  parseGuestImagePin,
  pruneGuestImages,
  type GuestImagePin,
} from "./guestImage";
import { inProcessLocks } from "./testing/inProcessLocks";

const content = Buffer.from("guest image bytes ".repeat(1000));
const sha256 = Crypto.createHash("sha256").update(content).digest("hex");
const pin: GuestImagePin = {
  url: "https://github.com/lopes-felipe/f5/releases/download/vm-guest-image-x/f5-guest.qcow2",
  sha256,
  size: content.byteLength,
};

let dir: string;
let locks: ReturnType<typeof inProcessLocks>;
beforeEach(() => {
  dir = FS.mkdtempSync(Path.join(OS.tmpdir(), "f5-guest-image-"));
  locks = inProcessLocks();
});
afterEach(() => {
  FS.rmSync(dir, { recursive: true, force: true });
});

const ensure = (fetchImpl: typeof fetch) =>
  ensureGuestImage({ pin, cacheDir: dir, fetch: fetchImpl, lock: locks.acquire });
const imageLock = () => guestImagePath(dir, sha256) + ".lock";

/** Serves `body` in small chunks; honors Range unless told to ignore or reject it. */
function server(
  body: Buffer,
  options: { ignoreRange?: boolean; rejectRange?: boolean; truncateAt?: number } = {},
): { fetch: typeof fetch; requests: Array<string | null> } {
  const requests: Array<string | null> = [];
  const fetchImpl = (async (_url: string, init?: RequestInit) => {
    const range = (init?.headers as Record<string, string> | undefined)?.Range ?? null;
    requests.push(range);
    if (range && options.rejectRange) return new Response("no", { status: 416 });
    let start = 0;
    let status = 200;
    const headers = new Headers();
    if (range && !options.ignoreRange) {
      start = Number(/^bytes=(\d+)-$/.exec(range)![1]);
      status = 206;
      headers.set("content-range", `bytes ${start}-${body.byteLength - 1}/${body.byteLength}`);
    }
    const slice = body.subarray(start, options.truncateAt ?? body.byteLength);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let i = 0; i < slice.byteLength; i += 1000)
          controller.enqueue(new Uint8Array(slice.subarray(i, i + 1000)));
        controller.close();
      },
    });
    return new Response(stream, { status, headers });
  }) as unknown as typeof fetch;
  return { fetch: fetchImpl, requests };
}

describe("parseGuestImagePin", () => {
  it("reads an unpinned lock as no image", () => {
    expect(parseGuestImagePin({ image: null })).toBeNull();
  });

  it("accepts a release asset of this repository", () => {
    expect(parseGuestImagePin({ image: pin })).toEqual(pin);
  });

  it.each([
    { ...pin, url: "http://github.com/lopes-felipe/f5/releases/download/x/y" },
    { ...pin, url: "https://example.com/f5-guest.qcow2" },
    { ...pin, url: "https://github.com/someone/else/releases/download/x/y" },
    // Dot segments, escaped or not, would normalize to another repository's asset.
    { ...pin, url: "https://github.com/lopes-felipe/f5/releases/download/../../../evil/repo/x/y" },
    { ...pin, url: "https://github.com/lopes-felipe/f5/releases/download/%2e%2e/%2e%2e/x/y" },
    { ...pin, url: "https://github.com/lopes-felipe/f5/releases/download/tag/dir/file" },
    { ...pin, url: "https://github.com/lopes-felipe/f5/releases/download/tag/file?x=1" },
    { ...pin, url: "https://user@github.com/lopes-felipe/f5/releases/download/tag/file" },
    { ...pin, url: "https://github.com:8443/lopes-felipe/f5/releases/download/tag/file" },
    { ...pin, sha256: "ABC" },
    { ...pin, size: -1 },
    { ...pin, size: 1e12 },
  ])("refuses %#", (image) => {
    expect(() => parseGuestImagePin({ image })).toThrow(GuestImageError);
  });

  it("allows any HTTPS URL only when asked (development override)", () => {
    const image = { ...pin, url: "https://example.com/f5-guest.qcow2" };
    expect(parseGuestImagePin({ image }, { allowAnyHttpsUrl: true })).toEqual(image);
  });
});

describe("ensureGuestImage", () => {
  it("downloads, verifies and caches the image", async () => {
    const { fetch, requests } = server(content);
    const path = await ensure(fetch);
    expect(path).toBe(guestImagePath(dir, sha256));
    expect(FS.readFileSync(path).equals(content)).toBe(true);
    await ensure(fetch);
    expect(requests).toHaveLength(1);
    expect(locks.held.size).toBe(0);
  });

  it("resumes a partial download and verifies the whole file", async () => {
    FS.writeFileSync(guestImagePath(dir, sha256) + ".part", content.subarray(0, 7000));
    const { fetch, requests } = server(content);
    const path = await ensure(fetch);
    expect(requests).toEqual(["bytes=7000-"]);
    expect(FS.readFileSync(path).equals(content)).toBe(true);
  });

  it("starts over when the server ignores the range", async () => {
    FS.writeFileSync(guestImagePath(dir, sha256) + ".part", content.subarray(0, 7000));
    const { fetch, requests } = server(content, { ignoreRange: true });
    const path = await ensure(fetch);
    expect(requests).toEqual(["bytes=7000-", null]);
    expect(FS.readFileSync(path).equals(content)).toBe(true);
  });

  it("starts over once with a full request when the server rejects the range (416)", async () => {
    FS.writeFileSync(guestImagePath(dir, sha256) + ".part", content.subarray(0, 7000));
    const { fetch, requests } = server(content, { rejectRange: true });
    const path = await ensure(fetch);
    expect(requests).toEqual(["bytes=7000-", null]);
    expect(FS.readFileSync(path).equals(content)).toBe(true);
  });

  it("keeps a truncated download for the next attempt", async () => {
    await expect(ensure(server(content, { truncateAt: 5000 }).fetch)).rejects.toThrow(
      /ended early/,
    );
    expect(FS.statSync(guestImagePath(dir, sha256) + ".part").size).toBe(5000);
    const { fetch, requests } = server(content);
    await ensure(fetch);
    expect(requests).toEqual(["bytes=5000-"]);
  });

  it("discards bytes that fail digest verification", async () => {
    const tampered = Buffer.from(content);
    tampered[10] = 0;
    await expect(ensure(server(tampered).fetch)).rejects.toThrow(/digest/);
    expect(FS.readdirSync(dir)).toEqual([]);
  });

  it("refuses a download larger than the pin", async () => {
    await expect(ensure(server(Buffer.concat([content, Buffer.from("x")])).fetch)).rejects.toThrow(
      /larger/,
    );
    expect(FS.existsSync(guestImagePath(dir, sha256))).toBe(false);
  });

  it("lets one of several concurrent callers download, and the rest reuse its file", async () => {
    const { fetch, requests } = server(content);
    const paths = await Promise.all([ensure(fetch), ensure(fetch), ensure(fetch)]);
    expect(new Set(paths)).toEqual(new Set([guestImagePath(dir, sha256)]));
    expect(requests).toHaveLength(1);
    expect(FS.readFileSync(paths[0]!).equals(content)).toBe(true);
    expect(locks.held.size).toBe(0);
  });

  it("waits for a download another process holds, then uses its result", async () => {
    const release = await locks.acquire(imageLock(), new AbortController().signal);
    const { fetch, requests } = server(content);
    const waiting = ensure(fetch);
    await new Promise((resolve) => setTimeout(resolve, 20));
    FS.writeFileSync(guestImagePath(dir, sha256), content);
    release();
    await expect(waiting).resolves.toBe(guestImagePath(dir, sha256));
    expect(requests).toHaveLength(0);
  });

  it("replaces a cached file whose size doesn't match the pin", async () => {
    FS.writeFileSync(guestImagePath(dir, sha256), "truncated");
    const { fetch, requests } = server(content);
    const path = await ensure(fetch);
    expect(requests).toHaveLength(1);
    expect(FS.readFileSync(path).equals(content)).toBe(true);
  });

  it("leaves a wrong-size file alone until it holds the lock", async () => {
    // The holder is replacing it right now; a waiter must not delete the replacement.
    FS.writeFileSync(guestImagePath(dir, sha256), "truncated");
    const release = await locks.acquire(imageLock(), new AbortController().signal);
    const { fetch, requests } = server(content);
    const waiting = ensure(fetch);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(FS.readFileSync(guestImagePath(dir, sha256), "utf8")).toBe("truncated");
    FS.writeFileSync(guestImagePath(dir, sha256), content);
    release();
    await expect(waiting).resolves.toBe(guestImagePath(dir, sha256));
    expect(requests).toHaveLength(0);
  });

  it("prunes other cached images, skipping a digest someone holds", async () => {
    const other = "b".repeat(64);
    const busy = "c".repeat(64);
    for (const digest of [other, busy]) {
      FS.writeFileSync(guestImagePath(dir, digest), "");
      FS.writeFileSync(guestImagePath(dir, digest) + ".part", "");
    }
    FS.writeFileSync(guestImagePath(dir, sha256), "");
    FS.writeFileSync(Path.join(dir, "unrelated"), "");
    const release = await locks.acquire(
      guestImagePath(dir, busy) + ".lock",
      new AbortController().signal,
    );
    await pruneGuestImages(dir, sha256, locks.acquire);
    release();
    expect(FS.readdirSync(dir).sort()).toEqual(
      [`${busy}.qcow2`, `${busy}.qcow2.part`, `${sha256}.qcow2`, "unrelated"].sort(),
    );
  });
});
