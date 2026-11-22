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

const content = Buffer.from("guest image bytes ".repeat(1000));
const sha256 = Crypto.createHash("sha256").update(content).digest("hex");
const pin: GuestImagePin = {
  url: "https://github.com/lopes-felipe/f5/releases/download/vm-guest-image-x/f5-guest.qcow2",
  sha256,
  size: content.byteLength,
};

let dir: string;
beforeEach(() => {
  dir = FS.mkdtempSync(Path.join(OS.tmpdir(), "f5-guest-image-"));
});
afterEach(() => {
  FS.rmSync(dir, { recursive: true, force: true });
});

/** Serves `body` in small chunks; honors Range unless `ignoreRange`. */
function server(
  body: Buffer,
  options: { ignoreRange?: boolean; truncateAt?: number } = {},
): { fetch: typeof fetch; requests: Array<string | null> } {
  const requests: Array<string | null> = [];
  const fetchImpl = (async (_url: string, init?: RequestInit) => {
    const range = (init?.headers as Record<string, string> | undefined)?.Range ?? null;
    requests.push(range);
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
    const path = await ensureGuestImage({ pin, cacheDir: dir, fetch });
    expect(path).toBe(guestImagePath(dir, sha256));
    expect(FS.readFileSync(path).equals(content)).toBe(true);
    await ensureGuestImage({ pin, cacheDir: dir, fetch });
    expect(requests).toHaveLength(1);
  });

  it("resumes a partial download and verifies the whole file", async () => {
    FS.writeFileSync(guestImagePath(dir, sha256) + ".part", content.subarray(0, 7000));
    const { fetch, requests } = server(content);
    const path = await ensureGuestImage({ pin, cacheDir: dir, fetch });
    expect(requests).toEqual(["bytes=7000-"]);
    expect(FS.readFileSync(path).equals(content)).toBe(true);
  });

  it("starts over when the server ignores the range", async () => {
    FS.writeFileSync(guestImagePath(dir, sha256) + ".part", content.subarray(0, 7000));
    const { fetch, requests } = server(content, { ignoreRange: true });
    const path = await ensureGuestImage({ pin, cacheDir: dir, fetch });
    expect(requests).toEqual(["bytes=7000-", null]);
    expect(FS.readFileSync(path).equals(content)).toBe(true);
  });

  it("keeps a truncated download for the next attempt", async () => {
    await expect(
      ensureGuestImage({ pin, cacheDir: dir, fetch: server(content, { truncateAt: 5000 }).fetch }),
    ).rejects.toThrow(/ended early/);
    expect(FS.statSync(guestImagePath(dir, sha256) + ".part").size).toBe(5000);
    const { fetch, requests } = server(content);
    await ensureGuestImage({ pin, cacheDir: dir, fetch });
    expect(requests).toEqual(["bytes=5000-"]);
  });

  it("discards bytes that fail digest verification", async () => {
    const tampered = Buffer.from(content);
    tampered[10] = 0;
    await expect(
      ensureGuestImage({ pin, cacheDir: dir, fetch: server(tampered).fetch }),
    ).rejects.toThrow(/digest/);
    expect(FS.readdirSync(dir)).toEqual([]);
  });

  it("refuses a download larger than the pin", async () => {
    await expect(
      ensureGuestImage({
        pin,
        cacheDir: dir,
        fetch: server(Buffer.concat([content, Buffer.from("x")])).fetch,
      }),
    ).rejects.toThrow(/larger/);
    expect(FS.existsSync(guestImagePath(dir, sha256))).toBe(false);
  });

  it("lets one of several concurrent callers download, and the rest reuse its file", async () => {
    const { fetch, requests } = server(content);
    const paths = await Promise.all([
      ensureGuestImage({ pin, cacheDir: dir, fetch }),
      ensureGuestImage({ pin, cacheDir: dir, fetch }),
      ensureGuestImage({ pin, cacheDir: dir, fetch }),
    ]);
    expect(new Set(paths)).toEqual(new Set([guestImagePath(dir, sha256)]));
    expect(requests).toHaveLength(1);
    expect(FS.readFileSync(paths[0]!).equals(content)).toBe(true);
    expect(FS.existsSync(guestImagePath(dir, sha256) + ".lock")).toBe(false);
  });

  it("waits for a download another process holds, then uses its result", async () => {
    const lock = guestImagePath(dir, sha256) + ".lock";
    // A live holder (this process stands in for another supervisor).
    FS.writeFileSync(lock, String(process.pid));
    const { fetch, requests } = server(content);
    const waiting = ensureGuestImage({ pin, cacheDir: dir, fetch });
    await new Promise((resolve) => setTimeout(resolve, 50));
    FS.writeFileSync(guestImagePath(dir, sha256), content);
    FS.rmSync(lock);
    await expect(waiting).resolves.toBe(guestImagePath(dir, sha256));
    expect(requests).toHaveLength(0);
  });

  it("replaces a cached file whose size doesn't match the pin", async () => {
    FS.writeFileSync(guestImagePath(dir, sha256), "truncated");
    const { fetch, requests } = server(content);
    const path = await ensureGuestImage({ pin, cacheDir: dir, fetch });
    expect(requests).toHaveLength(1);
    expect(FS.readFileSync(path).equals(content)).toBe(true);
  });

  it("prunes other cached images", async () => {
    const other = "b".repeat(64);
    FS.writeFileSync(guestImagePath(dir, other), "");
    FS.writeFileSync(guestImagePath(dir, other) + ".part", "");
    FS.writeFileSync(guestImagePath(dir, sha256), "");
    FS.writeFileSync(Path.join(dir, "unrelated"), "");
    await pruneGuestImages(dir, sha256);
    expect(FS.readdirSync(dir).sort()).toEqual([`${sha256}.qcow2`, "unrelated"]);
  });
});
